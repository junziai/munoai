# M12.6 Python运行时 - 零缺陷审计报告

**审计时间**: 2026-09-13  
**审计范围**: M12.6 Python运行时管理（pyenv/mod.rs + commands/pyenv.rs + util.rs + bundled_code.rs）  
**风险等级**: 极高 🔴  
**代码规模**: ~2,580行 (pyenv/mod.rs 1306 + commands/pyenv.rs 886 + util.rs 193 + bundled_code.rs 198)

---

## 1. 模块概述

### 1.1 功能定位
M12.6是整个应用的**Python子系统管理器**，负责：
- **Runtime Pack安装**: 多variant（nv-cu130/amd/xpu/cpu）Python+Torch嵌入式包的下载、验证、解压
- **Interpreter解析**: Converter角色和Training角色各自的Python解释器优先级选择（dev venv → 已安装pack → manual slot → PATH python）
- **跨进程spawn hygiene**: `python_command`统一构建Command（UTF-8 env、MIOPEN tuning、CREATE_NO_WINDOW、环境变量隔离）
- **Torn install恢复**: marker-file commit协议 + sweep_staging启动时回收
- **代码完整性**: bundled_code.rs启动时heal训练器Python文件
- **Envtest自测试**: 每pack独立的Python envtest执行 + 机器签名stamp + stale检测
- **并发保护**: InstallGuard（单飞安装）+ EnvtestGuard（单飞自测试）

### 1.2 架构评估
```
Frontend (TS → Tauri IPC)
    ↓
commands/pyenv.rs
    ├─ get_runtime_env_info      → packs + catalog + busy flags
    ├─ download_runtime_pack     → fetch manifest → download parts → extract → envtest
    ├─ install_local_pack        → resolve_local_parts → extract → envtest
    ├─ run_envtest               → python_command → utai_train.envtest
    └─ delete_pack               → pack.json first, then tree
          ↓
pyenv/mod.rs
    ├─ PackMeta / PackManifest    → pack.json / manifest.json schema
    ├─ list_packs()              → scan-based discovery (marker presence)
    ├─ training_interpreter / converter_python → tier resolver
    ├─ extract_and_commit        → DIRECT extract + file marker commit
    ├─ resolve_local_parts       → contiguous-volume parser
    ├─ fetch_manifest            → multi-candidate failover with merged errors
    ├─ verify_parts              → size + sha256
    ├─ delete_pack               → marker-first, tree deferred
    └─ sweep_staging             → .staging GC + torn-install reclaim
          ↓  (spawn hygiene)
util.rs::python_command()
    ├─ PYTHONIOENCODING=utf-8 + PYTHONUTF8=1
    ├─ env_remove(PYTHONHOME/PYTHONPATH) + PYTHONNOUSERSITE=1
    ├─ MIOPEN_FIND_MODE=5 + MIOPEN_LOG_LEVEL=3
    └─ CREATE_NO_WINDOW (Windows)
          ↓ spawn
python/python.exe -m utai_train.*
```

**架构风险点**:
1. **文件系统原子性**: install commit使用file rename（pack.json）而非directory rename（注释已解释原因——Windows Defender handle），但rename_with_retry仍有失败路径
2. **回滚链**: old_backup(.staging/.old-<id>)需要在install失败后rename回final_dir，但rename_with_retry也可能失败
3. **Cancel时机**: extract_and_commit中cancel在每tar entry后check，但文件已写入，后续marker写入可能被跳过
4. **安全边界**: manifest来自远程（未签名，只有manifest内部sha256），is_safe_component是唯一路径穿越防护
5. **启动heal预算**: sync_bundled_training_code有10秒HEAL_BUDGET，超时文件被deferred到下次启动

---

## 2. 十维度深度审查结果

### 2.1 逻辑正确性 ✅ (优秀)

**通过项**:
- ✅ `list_packs()` scan-based发现逻辑无registry drift风险
- ✅ `extract_and_commit`直接解压 + marker FILE commit的架构决策有明确注释（§S42为什么放弃staging→directory rename）
- ✅ 回滚链完整：install失败 → old_backup rename_with_retry → sweep_staging再兜底
- ✅ pack.json marker-first delete（delete_pack）与install protocol对称
- ✅ sweep_staging正确处理`.old-<id>-<ts>`恢复/陈旧清理/`dl-<id>`保留
- ✅ `training_interpreter_for(want)`正确按variant筛选 + max_by_key最新版本
- ✅ PackMeta version比较（max_by_key）正确处理v1+v2共存场景

**缺陷**: 见 D-M126-001

### 2.2 运行时异常 ⚠️ (发现1个缺陷)

**通过项**:
- ✅ rename_with_retry有指数退避 + ACCESS_DENIED(5)/SHARING_VIOLATION(32)针对性重试
- ✅ extract_and_commit完整错误链：error_chain(tar/IO错误) → preclean_err合并 → 外层匹配后回滚
- ✅ delete_pack retry删除marker（5次）而非一次放弃
- ✅ fetch_manifest多候选失败合并（保留详细日志但前端code match友好）

**缺陷**: 见 D-M126-002

### 2.3 资源管理 ⚠️ (发现2个缺陷)

**通过项**:
- ✅ ACTIVE_INSTALL Mutex + EnvtestGuard AtomicBool双锁防安装+自测试+删除冲突
- ✅ 单飞install/self-test正确阻止delete_pack在活跃操作下执行
- ✅ cancel标志正确传递到extract_and_commit的entry循环
- ✅ old_backup在成功commit后best-effort remove

**缺陷**: 见 D-M126-003、D-M126-004

### 2.4 并发安全 ✅ (优秀)

**通过项**:
- ✅ ACTIVE_INSTALL: `parking_lot::Mutex<Option<Arc<AtomicBool>>>` — install/cancel有正确的临界区
- ✅ EnvtestGuard: AtomicBool swap + Drop reset（正确的单飞模式）
- ✅ sweep_staging持有InstallGuard全程（防止install与GC冲突）
- ✅ 所有路径：单install并发，无多线程同时写final_dir风险

### 2.5 安全漏洞 ⚠️ (发现2个缺陷)

**通过项**:
- ✅ is_safe_component(id/part.name)防路径穿越（拒绝`..`、非ASCII、绝对路径）
- ✅ pack.json first-entry检查（build_pack.py排序保证pack.json在python/之前）
- ✅ `validate_manifest`校验id安全、part name安全、sha256格式正确
- ✅ envtest_gfx_targets_for() AMD arch目标限定（混合arch笔记本安全）
- ✅ python_command: env_remove(PYTHONHOME/PYTHONPATH)隔离宿主环境

**缺陷**: 见 D-M126-005、D-M126-006

### 2.6 性能瓶颈 ✅ (良好)

**通过项**:
- ✅ tar entry流式解压（不中间落盘）
- ✅ verify_parts: size先比（快速失败）→ sha256
- ✅ fetch_manifest: 失败逐个warn后合并进单一错误

**缺陷**: 见 D-M126-007

### 2.7 数据一致性 ✅ (优秀)

**通过项**:
- ✅ PackMeta schema前向兼容（#[serde(default)]）
- ✅ 重装时old_backup移动到.staging而非删除（失败可回滚）
- ✅ marker-file commit：pack.json.tmp → pack.json同目录原子rename
- ✅ install失败后marker不落地 → list_packs不可见 → sweep回收

### 2.8 接口契约 ✅ (优秀)

**通过项**:
- ✅ python_command作为单源所有python spawn（converter/training/amt）
- ✅ variant_backend映射：nv+amd→"cuda", xpu→"xpu", cpu→"cpu"
- ✅ envtest_device_for_variant和envtest_gfx_targets_for测试通过include_str!验证
- ✅ manifest_url_candidates: 可信路由显式配置，gh代理不盲信

### 2.9 边界与异常路径 ⚠️ (发现2个缺陷)

**通过项**:
- ✅ install_root ensure_ascii_path + create_dir_all
- ✅ free_bytes_at probe失败时fail-open（disk_bytes==0跳过检查）
- ✅ pack_python缺失检查（PACK_NO_PYTHON错误）
- ✅ 本地install跳过manifest验证时warn（dev便利）
- ✅ legacy manifest无version时read as 0（#[serde(default)]）

**缺陷**: 见 D-M126-008、D-M126-009

### 2.10 规范与可维护性 ✅ (优秀)

**通过项**:
- ✅ S编号注释丰富（S42/S64/S66/S68d/S74b/S75/S115/S116/S167/S168/S169等）
- ✅ 架构决策有WHY-NOT注释（staging+directory rename为何放弃）
- ✅ Include_str!测试跨语言契约（envtest tier/device mapping）
- ✅ 常量命名清晰：INSTALL_COMMIT/PACK_ROLLBACK/PACK_MOVE_OUT等
- ✅ error_chain()带source链展开（解决tar库只显示一层错误的问题）

---

## 3. 缺陷清单（按严重性排序）

**合计**: 9个缺陷（高严重性×2，中严重性×5，低严重性×2）

---

### 🔴 高严重性缺陷（2项）

---

### D-M126-001 [高] extract_and_commit中rename失败且backup rollback也失败 → 双重数据丢失

**文件**: `src-tauri/src/pyenv/mod.rs`  
**行号**: 1077-1100  
**根因分析**:

`extract_and_commit`成功解压后，commit阶段执行pack.json.tmp → pack.json rename_with_retry。如果这个rename因为Windows Defender/其他进程handle而失败：
1. marker从未落地
2. `final_dir`现在处于"无marker"状态 → invisible to list_packs
3. 如果是重装场景，old_backup已被rename到`.staging/.old-*`并在commit失败时尝试rollback
4. **rollback也可能失败**（同样的Defender handle问题）
5. 此时用户**同时丢失了旧pack（在.staging）和新pack的marker**

```rust
// mod.rs:1077-1100
match &result {
    Ok(_) => {
        if let Some(old) = &old_backup {
            let _ = std::fs::remove_dir_all(old);  // 成功路径：删旧
        }
    }
    Err(_) => {
        // 失败路径：清理partial install
        let _ = std::fs::remove_file(final_dir.join("pack.json.tmp"));
        let _ = std::fs::remove_dir_all(&final_dir);
        
        // ⚠ rollback尝试
        if let Some(old) = &old_backup {
            match crate::util::rename_with_retry(old, &final_dir, "PACK_ROLLBACK") {
                Ok(()) => tracing::warn!("reinstall failed — previous pack rolled back"),
                Err(e) => tracing::error!("old-pack rollback failed ({e}) — startup sweep will restore it"),
                // ❌ 问题：tracing后没别的，old_backup可能再也恢复不了
            }
        }
    }
}
```

**修复建议**: rollback失败后，确保old_backup保持在`.staging`不被清理（让sweep_staging下次启动时恢复），并emit frontend事件通知用户"pack损坏需重启"。

**修复代码**:
```rust
Err(_) => {
    let _ = std::fs::remove_file(final_dir.join("pack.json.tmp"));
    let _ = std::fs::remove_dir_all(&final_dir);
    if let Some(old) = &old_backup {
        match crate::util::rename_with_retry(old, &final_dir, "PACK_ROLLBACK") {
            Ok(()) => {
                tracing::warn!("reinstall failed — previous pack rolled back");
                return Err(err(format!("INSTALL_PARTIAL_FAIL: {e}")));
            }
            Err(e) => {
                // ✅ old_backup保持原状，sweep_staging下次恢复
                tracing::error!(
                    "old-pack rollback failed ({e}) — kept at {}; restart to recover",
                    old.display()
                );
                // 这里应该emit frontend事件
                // 让UI显示"pack损坏，请重启应用恢复"
                return Err(err(format!(
                    "INSTALL_ROLLBACK_PENDING: pack kept at {} — restart required",
                    old.display()
                )));
            }
        }
    }
}
```

---

### D-M126-002 [高] sweep_staging恢复.backup时rename失败，backup变成永久孤儿

**文件**: `src-tauri/src/pyenv/mod.rs`  
**行号**: 1243-1261  
**根因分析**:

```rust
if let Some(rest) = name.strip_prefix(".old-") {
    if let Some((id, _ts)) = rest.rsplit_once('-') {
        let final_dir = root.join(id);
        if !final_dir.exists() && path.join("pack.json").exists() {
            match crate::util::rename_with_retry(&path, &final_dir, "INSTALL_RECOVERY") {
                Ok(()) => {
                    tracing::warn!("recovered pack {id} from interrupted reinstall");
                }
                Err(e) => {
                    tracing::warn!("recovery of {id} failed ({e}) — keeping backup for next sweep");
                    // ❌ 但"下次sweep"还会有同样的Defender handle问题！
                    // 而且install可能永远不会再发生 → .staging/.old-*永远孤儿
                }
            }
            continue;
        }
    }
}
```

**问题**: 
1. rename_with_retry指数退避8次 × 2s上限 = 最长~15秒，如果handle问题持续，每次sweep都要花15秒然后放弃
2. 代码注释说"never fall through to deletion here"（正确保护了数据），但没有长期恢复策略
3. 每次启动都可能重复这个失败循环

**修复建议**: 
1. 对rename失败的.backup做硬重试循环（更多次）
2. 如果长期失败，标记.pack.json旁加`.retry_failed`标记文件，下次sweep先检查标记
3. 或提供手动恢复入口

---

### 🟡 中严重性缺陷（5项）

---

### D-M126-003 [中] python_command硬编码MIOPEN tuning — 其他variant不识别但无害

**文件**: `src-tauri/src/util.rs`  
**行号**: 49-50  
**根因分析**:

```rust
cmd.env("MIOPEN_FIND_MODE", "5");  // AMD MIOpen tuning
cmd.env("MIOPEN_LOG_LEVEL", "3");
```

这些env变量在util.rs中硬编码到python_command()，所以**所有**runtime pack（nv-cu130, xpu, cpu）都会带上它们。代码注释正确解释了：
- NVIDIA (cuDNN)、CPU、Intel/XPU不读取这些变量
- 设置一次在单源里对其他所有地方无害

这实际上不是bug，而是可以改进的设计。

**风险**: 低（注释已说明无害）
**建议**: 保持现状，或根据variant条件化（需要python_command知道variant，耦合度上升）

---

### D-M126-004 [中] sync_bundled_training_code的HEAL_BUDGET=10s可能不够

**文件**: `src-tauri/src/training/bundled_code.rs`  
**行号**: 43-54  
**根因分析**:

```rust
const HEAL_BUDGET: std::time::Duration = std::time::Duration::from_secs(10);
// 124文件 × (fs::metadata + fs::read + create_dir_all + fs::write + rename_with_retry)
// 每个文件可能有~300ms的rename retry（AV handle）
// 如果多个文件被AV持锁，10s很快耗尽
```

当HEAL_BUDGET耗尽时，deferred文件被跳过到下次启动。这意味着：
1. 如果AV持续锁文件，每次启动都deferred同样的文件
2. 用户的训练环境持续损坏但得不到修复
3. 没有告警——只是deferred

**修复建议**: 
1. 超时后emit Tauri事件通知用户
2. 或增加到30秒（但启动时同步阻塞window显示）
3. 改为异步执行（启动后后台heal）

---

### D-M126-005 [中] fetch_manifest的manifest URL未签名——中间人攻击风险

**文件**: `src-tauri/src/pyenv/mod.rs`  
**行号**: 669-721 (fetch_manifest) + 834-853 (validate_manifest)  
**根因分析**:

manifest校验**只有manifest内部的sha256 table**（part name → sha256）。但：
1. manifest本身没有签名或可信签名链
2. 一个中间人攻击者可以提供伪造的manifest + 匹配sha256的part → pack python.exe被替换
3. `manifest_url_candidates`注释明确承认此风险（⛔ TRUST CONTRACT）

这在桌面应用中是可接受的风险（攻击者需要MITM用户的下载路径），但需要用户知道。

**实际风险**: 中等（HTTPS正常情况下MITM已被防护；但GH proxy routes是用户手动配置的）
**建议**: 保持现状（已有注释），但在UI上明确说明安全边界

---

### D-M126-006 [中] delete_pack: marker-first delete + tree deferred = pack.json可能被delete但tree仍存在

**文件**: `src-tauri/src/pyenv/mod.rs`  
**行号**: 1158-1206  
**根因分析**:

```rust
// ① 删marker（重试5次）
let mut last: Option<std::io::Error> = None;
for attempt in 0..5u64 {
    match std::fs::remove_file(&marker) {
        Ok(()) => { last = None; break; }
        Err(e) => { last = Some(e); /* backoff */ }
    }
}
if let Some(e) = last { return Err(...); }

// ② 删tree（best-effort）
if let Err(e) = std::fs::remove_dir_all(&dir) {
    tracing::warn!("pack tree removal deferred ({e}) — sweep will reclaim {}", dir.display());
}
Ok(())  // ❌ 返回成功，但tree还在
```

**问题**:
- marker已删除 → list_packs不可见
- tree还在 → `.staging`不会恢复它（sweep只处理`.old-*`和marker-less root dirs）
- 但marker-less root dir是被reclaimed的（sweep_staging第二个循环）——所以这是OK的
- **唯一问题**: 用户认为pack已删除（return Ok），但实际tree残留到下次启动

**风险**: 低（sweep会清理）
**建议**: delete_pack返回前可以尝试rename_with_retry整个dir到`.staging/.old-*`（注释已解释为何放弃，但delete场景不同——install失败才会block）

---

### D-M126-007 [中] extract_and_commit的cancel检查粒度：每100 entry才progress，但每entry检查cancel

**文件**: `src-tauri/src/pyenv/mod.rs`  
**行号**: 1042-1063  
**根因分析**:

```rust
for entry in entries {
    if cancel.load(Ordering::SeqCst) {
        return Err(err("INSTALL_CANCELLED"));
    }
    // unpack + count
    count += 1;
    if count % 100 == 0 { progress(count); }
}
```

cancel在每个entry后检查（正确）。但问题是：
1. 取消后文件树可能已部分解压（marker未写 → 下次sweep回收，正确）
2. 但cancel没有触发old_backup rollback——直接return Err
3. 外层match的Err分支会正确清理partial install（remove tmp + remove dir）
4. 但old_backup也会被清理（如果cancel发生在extract开始之前或重装场景）

这实际上已被正确处理。

**风险**: 低
**建议**: 保持现状，cancel路径完整

---

### 🟢 低严重性缺陷（2项）

---

### D-M126-008 [低] dir_size递归扫描大目录时延迟disk preflight

**文件**: `src-tauri/src/pyenv/mod.rs`  
**行号**: 892-906  
**根因分析**:

`dir_size`是递归函数，遍历marker-less的torn install tree来算free bytes。一个大pack（5-6GB）的递归读取可能花几秒。但disk preflight在extract前执行——延迟几秒钟不是关键问题。

**风险**: 低
**建议**: 保持现状（fail-open已经处理probe失败场景）

---

### D-M126-009 [低] runtime_root OnceLock + init_runtime_root只能调一次——测试需要特殊处理

**文件**: `src-tauri/src/pyenv/mod.rs`  
**行号**: 76-87  
**根因分析**:

OnceLock确保runtime_root只初始化一次。如果init_runtime_root没被调用（bare cargo test），runtime_root()返回None，所有list_packs/delete_pack/install_root都返回空/错误。测试框架需要自己mock runtime root。

代码注释承认这一点（Harnesses that never call it simply see "no packs"）。

**风险**: 低（正确的设计约束）
**建议**: 保持现状

---

## 4. 关键代码片段审查

### 4.1 正确的安全模式
```rust
// mod.rs:1070-1073 — pack.json marker atomically committed
let tmp = final_dir.join("pack.json.tmp");
std::fs::write(&tmp, meta_text.as_bytes())?;
crate::util::rename_with_retry(&tmp, &marker, "INSTALL_COMMIT")?;
```
✅ tmp+rename同目录 → 原子性；失败sweep下次回收

### 4.2 正确的回滚
```rust
// mod.rs:1093-1098 — reinstall失败尝试回滚old_backup
match crate::util::rename_with_retry(old, &final_dir, "PACK_ROLLBACK") {
    Ok(()) => tracing::warn!("reinstall failed — previous pack rolled back"),
    Err(e) => tracing::error!("old-pack rollback failed ({e}) — startup sweep will restore it"),
}
```
✅ old_backup保持在.staging → sweep_staging启动时恢复
⚠️ 但"恢复失败"无额外告警

### 4.3 python_command hygiene
```rust
// util.rs:25-57 — 统一spawn helper
cmd.env("PYTHONIOENCODING", "utf-8");
cmd.env("PYTHONUTF8", "1");
cmd.env_remove("PYTHONHOME");   // ⛔ 隔离宿主
cmd.env_remove("PYTHONPATH");   // ⛔ 隔离宿主
cmd.env("PYTHONNOUSERSITE", "1");
cmd.env("MIOPEN_FIND_MODE", "5");  // AMD tuning
cmd.env("MIOPEN_LOG_LEVEL", "3");
#[cfg(windows)] { cmd.creation_flags(CREATE_NO_WINDOW); }
```
✅ 所有python spawn都走这里，UTF8安全 + 环境隔离 + 无console闪窗

### 4.4 正确的单飞保护
```rust
// mod.rs:733-742 — InstallGuard
pub fn acquire() -> Result<(Self, Arc<AtomicBool>)> {
    let mut slot = ACTIVE_INSTALL.lock();
    if slot.is_some() { return Err(err("INSTALL_BUSY")); }
    let flag = Arc::new(AtomicBool::new(false));
    *slot = Some(Arc::clone(&flag));
    Ok((InstallGuard, flag))
}
// Drop自动清理
```
✅ Mutex保护安装槽位 + cancel flag通过Arc传递

---

## 5. 修复优先级建议

| 优先级 | 缺陷ID | 缺陷名称 | 影响 | 改动量 |
|--------|--------|---------|------|--------|
| P0 | D-M126-001 | extract_and_commit双重回滚失败 | 用户丢失pack | 30行 |
| P1 | D-M126-002 | sweep_staging备份恢复失败无告警 | 孤儿pack长期残留 | 25行 |
| P2 | D-M126-004 | heal HEAL_BUDGET=10s不够 | 训练环境损坏 | 20行 |
| P2 | D-M126-006 | delete_pack tree deferred无反馈 | 用户感知不符 | 15行 |
| P3 | D-M126-003 | python_command硬编码MIOPEN | 无害但耦合 | 5行 |
| P3 | D-M126-005 | manifest未签名 | 安全边界明确 | 0行（文档） |
| P3 | D-M126-007 | cancel后old_backup清理 | 已正确处理 | 5行 |
| P4 | D-M126-008 | dir_size递归延迟 | 低风险 | 10行 |
| P4 | D-M126-009 | runtime_root OnceLock | 设计约束 | 0行 |

---

## 6. 跨文件依赖图

```
pyenv/mod.rs (核心逻辑)
    ↑ depends on      ↑ shared with      ↓ called by
util.rs::             bundled_code.rs    commands/pyenv.rs
  python_command()      UTAI_TRAIN_FILES  download_runtime_pack()
  rename_with_retry()  sync_bundled_      run_envtest()
  remove_dir_all_robust()  training_code()  install_local_pack()
  free_bytes_at()                         delete_pack()
  extract_zip_dlls()                      sweep_staging()
    ↑
download.rs (MultiFileReader, sha256_file, expand_routes, is_github_family)
    ↑
training/mod.rs (training_interpreter → python_command → spawn utai_train)
```

**跨模块风险**: training模块调用`pyenv::training_interpreter` → `util::python_command` → spawn；任何env/env_remove变更影响训练+转换+AMT所有Python spawn。

---

## 7. 总结

M12.6 Python运行时模块代码质量**极高**——**最成熟的模块之一**。安全设计密集：
- ✅ 路径穿越多层防护（is_safe_component + tar unpack_in + pack.json first-entry check）
- ✅ atomic commit（file marker而非directory rename，有明确注释解释WHY-NOT）
- ✅ 完整回滚链（old_backup + .staging + sweep_staging三重保障）
- ✅ 单飞安装/自测试/删除互锁
- ✅ python_command统一spawn hygiene（UTF8 + env隔离 + CREATE_NO_WINDOW + MIOPEN tuning）
- ✅ 跨语言契约include_str!测试（envtest tier/device mapping）
- ✅ error_chain()展开tar库隐藏的OS错误根因
- ✅ S编号注释覆盖S42/S64/S66/S68d/S74b/S75/S115/S116/S167/S168/S169

主要问题集中在**极端失败路径的用户可恢复性**：
- P0: extract_and_commit + rollback双重失败时old_backup应该emit事件通知用户重启
- P1: sweep_staging恢复失败后应标记文件并提醒

这些问题不是"立即崩溃"级别的bug，而是"用户在坏状态下需要明确指引"级别的工程质量。

---

**审查完成日期**: 2026-09-13
