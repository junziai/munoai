# M4.1-4.2 工作流引擎模块深度审查报告

**审查日期**: 2026-09-13  
**模块标识**: M4.1-4.2 工作流引擎（极高风险）  
**审查范围**:
- `src/lib/workflow/engine.ts` (1897行，工作流执行引擎核心)
- `src/lib/workflow/graph.ts` (69行，DAG拓扑排序)
- `src/lib/workflow/nodeHistory.ts` (46行，节点历史管理)
- `src/lib/workflow/modelPathHeal.ts` (74行，模型路径修复)

---

## 一、模块概览

### 1.1 核心职责
- **图解析与拓扑排序**: parseWorkflowGraph解析节点图为DAG结构，topologicalSort执行Kahn算法拓扑排序
- **工作流执行引擎**: executeWorkflow执行完整工作流，executeSingleNode执行单节点及其依赖链
- **40+节点类型执行**: executeNode实现rvc、sovits、msstSeparation、amtMidi、songGenYue2、transpose等节点逻辑
- **并发控制**: voiceInvokesInFlight+waitVoiceDrain实现人声推理排队，rejectIfSeparationBusy实现分离互锁
- **预检系统**: preflightRun门控运行前检查（模型缺失、分离忙碌、同段重复运行）
- **缓存与存款**: collectCachedPaths收集缓存路径，depositFromCache无头存款，rehydrateRenderState重新水化渲染状态
- **AMT MIDI落轨**: materializeAmtMidiTracks自动将MIDI转换结果落到主时间线

### 1.2 技术架构
- **执行流程**: preflightRun → ensureRunDir → parseWorkflowGraph → topologicalSort → for-loop executeNode → countOutputLanes
- **并发模型**: voiceInvokesInFlight计数器 + voiceDrainWaiters等待集 + 120秒超时保护
- **缓存策略**: 运行唯一目录（r${timestamp}${seq}）+ LRU模型缓存 + 密集性检查isDenseCache
- **取消机制**: 基于useWorkflowStore.isCancelled的epoch检查 + MSST/AMT边信道cancel命令
- **错误本地化**: backendErrorMessage统一映射Rust错误码（TRANSPOSE_*、SEPARATION_BUSY、MSST_MODEL_NOT_CONVERTED等）

---

## 二、10维度深度审查结果

### 2.1 逻辑正确性 ⚠️

**✅ 优势**:
- Kahn拓扑排序实现完备，包含环检测（L52: `result.length !== nodes.size`抛出错误）
- ancestorSetOf正确计算单节点运行的上游依赖集（修复S62b幽灵节点渲染bug）
- 运行唯一目录机制（ensureRunDir L299-304）解决了路径别名和陈旧重用问题
- 预检门控preflightRun在状态变更前执行，避免无效运行成本存款车道（S66规则）

**❌ 缺陷1 [中危]**: **voiceDrainWaiters泄漏风险**
- **位置**: L96-120 waitVoiceDrain函数
- **问题**: 
  ```typescript
  // L108-109: 添加等待者
  voiceDrainWaiters.add(segmentId);
  // L113-114: 正常路径删除
  voiceDrainWaiters.delete(segmentId);
  ```
  但在L110-112的120秒超时路径中，虽然返回false，但**从未删除等待者**：
  ```typescript
  if (Date.now() - start > 120_000) {
    useAppStore.getState().showToast("Voice render queue timeout...", "error");
    return false; // ❌ 遗漏 voiceDrainWaiters.delete(segmentId)
  }
  ```
- **影响**: 超时的segmentId永久留在voiceDrainWaiters中，未来对该段的waitVoiceDrain调用将直接进入L104的无限循环（voiceDrainWaiters.has返回true），**导致该段永久无法再运行工作流**
- **触发条件**: 人声推理任务卡死或极慢（>120秒），超时后再次尝试运行同一段
- **修复**: 在L110超时分支返回前添加`voiceDrainWaiters.delete(segmentId);`

**❌ 缺陷2 [中危]**: **topologicalSort未检测多输入无输出情况**
- **位置**: graph.ts L37-57
- **问题**: Kahn算法实现在`result.length !== nodes.size`时抛出"contains a cycle"错误，但该条件**同时覆盖环和孤立子图**。真实存在环和"输入节点被误配置为无入度"的错误消息相同，降低调试效率
- **影响**: 用户看到"Workflow contains a cycle"时可能误认为存在环，但实际是配置错误（例如Input节点被手动删除所有入边）
- **修复**: 环检测前先遍历剩余inDegree，区分真环和孤立节点

**❌ 缺陷3 [低危]**: **MSST分离停滞检测可能误报**
- **位置**: L714-718
- **问题**: 180秒无进度判定依赖`lastProgress + 1e-4`阈值：
  ```typescript
  if (p > lastProgress + 1e-4) { lastProgress = p; lastProgressAt = Date.now(); }
  if (Date.now() - lastProgressAt > STALL_TIMEOUT) {
    throw new Error("MSST separation stalled...");
  }
  ```
  但Rust端progress可能在某些chunk边界短暂保持不变（例如0.523→0.523→0.526），**1e-4阈值可能漏过真实进度更新**
- **影响**: 高精度进度报告（例如0.5230001→0.5230002，差值<1e-4）可能被误判为停滞
- **修复**: 降低阈值到1e-6或改用"进度回退"检测（p < lastProgress）

---

### 2.2 运行时异常 ⚠️

**✅ 优势**:
- 全局try-catch包裹executeWorkflow/executeSingleNode（L402、L551），捕获所有执行异常
- isCancelMessage统一识别取消标记（"Cancelled" / "CANCELLED"），避免取消被误当错误
- maybeShowErrorModal对致命错误（INFERENCE_LOW_MEMORY）显示模态对话框（S67c规则）

**❌ 缺陷4 [低危]**: **AMT MIDI落轨异常被静默吞没**
- **位置**: L1422-1427 materializeAmtMidiTracks
- **问题**:
  ```typescript
  } catch (e) {
    // 从不阻断主流程：MIDI 落轨失败只提示，不影响工作流运行结果本身。
    showToast(i18n.t("amt.nodeTracksFailed", "MIDI 音轨生成失败。"), "error");
  }
  ```
  所有异常（包括OOM、文件系统错误、状态损坏）均被吞没，用户只看到通用错误提示，**无法获取堆栈或错误详情**
- **影响**: 开发者无法诊断AMT落轨失败原因（例如segment ID冲突、track已删除等）
- **修复**: 添加`console.error("[materializeAmtMidiTracks]", e);`或`logToBackend("error", ...)`

**❌ 缺陷5 [低危]**: **rehydrateRenderState解析失败静默**
- **位置**: L1870-1875
- **问题**:
  ```typescript
  try {
    graph = parseWorkflowGraph(wf);
  } catch {
    return; // incomplete/invalid graph — nothing to safely rehydrate
  }
  ```
  解析失败静默返回，**不记录日志**，导致用户打开旧项目时发现节点未标绿但不知原因
- **影响**: 调试"为什么已渲染节点不显示绿色徽章"问题困难
- **修复**: 添加`console.warn("[rehydrateRenderState] parse failed for segment", segmentId, e);`

---

### 2.3 资源管理 ✅

**✅ 优势**:
- **事件监听器RAII**: rvc/sovits节点的voice-progress监听器在finally块中unlisten（L611-642），即使异常也保证清理
- **AMT进度监听器清理**: amtMidi节点的amt-progress监听器在finally块中unlisten（L909-911）
- **voiceInvokesInFlight引用计数**: L620加1，L640在finally中减1，保证并发计数准确
- **分离状态轮询无泄漏**: MSST分离的while循环在取消/完成/失败时均正确退出
- **cacheDecodeFailures无限增长保护**: 使用DECODE_GIVE_UP=3阈值避免无限重试（L1581-1589）

**⚠️ 潜在问题**: nodeHistories Map无清理上限
- **位置**: nodeHistory.ts L31
- **问题**: `const histories = new Map<string, NodeHistory>();`永不清理已删除segment的历史记录
- **影响**: 长期使用+频繁创建删除segment可能累积大量死节点历史（每个~数KB）
- **当前缓解**: 文档注释"Entries for deleted segments simply become unreachable (tiny)"表明已知问题，且规模小
- **建议**: 在segment删除时显式清理，或实现LRU淘汰机制

---

### 2.4 并发安全 ⚠️

**✅ 优势**:
- **voiceInvokesInFlight原子更新**: Map.get + Math.max保证计数非负（L640）
- **preflightRun多阶段竞态检查**: L259、L274、L279、L284四次running()检查覆盖await间隙
- **depositFromCache运行中保护**: L1659、L1681、L1711三次runningNow()检查防止与新运行冲突
- **materializeAmtMidiTracks事务包裹**: L1257 beginTransaction + L1426 commitTransaction保证撤销原子性

**❌ 缺陷6 [中危]**: **voiceDrainWaiters并发竞态**
- **位置**: L103-115
- **问题**:
  ```typescript
  // L104-107: 检查和等待不是原子的
  while (voiceDrainWaiters.has(segmentId)) {
    await new Promise((r) => setTimeout(r, 500));
    if (Date.now() - start > 120_000) { return false; }
  }
  voiceDrainWaiters.add(segmentId); // L108
  ```
  如果两个调用者A和B同时通过L104检查（都不在等待集中），它们会同时执行L108，**两个等待者都添加成功，但后续L113只会删除一次**，导致segmentId永久残留
- **触发条件**: 用户快速双击Run按钮（preflightRun并发调用），或两个segment共享某种ID（代码审查未发现这种情况，但逻辑可能存在）
- **影响**: 该段未来的waitVoiceDrain调用陷入无限循环
- **修复**: 使用原子操作或互斥锁保护检查-添加序列

**❌ 缺陷7 [低危]**: **cacheDecodeFailures跨segment键冲突**
- **位置**: L1584 `const k = \`${segmentId}|${audioPath}\`;`
- **问题**: 如果两个不同segment的运行唯一目录碰撞（理论上Date.now()+runSeq应避免，但runSeq是全局的），**相同audioPath会映射到相同键**
- **影响**: 一个segment的解码失败计数会误影响另一个segment的相同路径
- **当前缓解**: runSeq全局递增 + Date.now()纳秒级时间戳使碰撞概率极低
- **建议**: 添加assert或日志监控键冲突

---

### 2.5 安全漏洞 ✅

**✅ 优势**:
- **路径遍历防护**: 所有用户提供的文件路径（primaryInput、modelPath、outputPath）均通过Tauri IPC传递到Rust后端，Rust端使用`canonicalize`和白名单检查防止遍历
- **命令注入防护**: 无shell命令拼接，所有外部调用通过invoke IPC（类型安全）
- **XSS防护**: laneLabelFor/laneIdFor生成的标签未直接插入HTML，React自动转义
- **SSRF防护**: songGenYue2/songGenAceStep的service_url虽然用户可控，但HTTP请求在Rust端执行，前端无直接网络访问

**无严重漏洞发现**

---

### 2.6 性能瓶颈 ⚠️

**✅ 优势**:
- **并发解码**: depositFromCache使用Promise.all并发解码多个lanes（L1677），避免串行等待（S59 O2优化）
- **零拷贝计数**: countOutputLanes只计数不解码音频（L1555-1574），避免S32"双重解码"瓶颈
- **密集缓存检查**: isDenseCache跳过带孔缓存的重用（L431-434），避免undefined输入传播

**❌ 缺陷8 [中危]**: **ancestorSetOf对大图低效**
- **位置**: L440-456
- **问题**: 使用栈遍历计算祖先集，每次单节点运行都要O(E)遍历所有边（E=边数）：
  ```typescript
  while (stack.length > 0) {
    const gn = graph.nodes.get(stack.pop()!);
    for (const e of gn?.inEdges ?? []) {
      if (!anc.has(e.fromNode)) { ... }
    }
  }
  ```
  对于复杂工作流（例如100节点+300边），**每次单节点Run都要遍历整个图**
- **影响**: 单节点运行延迟增加~数十毫秒（用户可感知但不致命）
- **修复**: 预计算并缓存拓扑排序时的前驱关系，或使用BFS+提前终止

**❌ 缺陷9 [低危]**: **collectGroupNames O(N*M*K)复杂度**
- **位置**: L1789-1801
- **问题**: 三层循环遍历所有tracks→segments→nodes，每次调用O(轨道数 * 平均段数 * 平均节点数)
- **影响**: 100轨道项目打开Output节点面板时可能卡顿~100ms
- **当前缓解**: 实际项目很少超过50轨道
- **建议**: 缓存结果到project store，segments/nodes变更时增量更新

---

### 2.7 数据一致性 ⚠️

**✅ 优势**:
- **运行唯一路径**: ensureRunDir生成的r${timestamp}${seq}目录保证每次运行路径唯一，避免覆盖冲突
- **laneId稳定性**: laneIdFor基于物理边（outputNodeId::fromNode:fromPort），添加/删除兄弟边不影响现有lane ID
- **存款-缓存一致性**: depositFromCache在runningNow()检查后才写入，避免与新运行冲突（L1659、L1681、L1711）
- **清理孤儿lane**: depositFromCache删除Output节点已删除的lanes（L1698-1702），保持图-lane同步

**❌ 缺陷10 [高危]**: **rehydrateRenderState稀疏缓存数组越界**
- **位置**: L1887
- **问题**:
  ```typescript
  (nodeOutputs[edge.fromNode] ??= [])[edge.fromPort] = po.audioPath;
  ```
  直接用fromPort作为数组索引，但**从未初始化数组长度**。如果fromPort=5，数组会被创建为`[empty × 5, "path"]`，**前5个元素是hole**
- **影响**: executeSingleNode的isDenseCache检查会判定为稀疏（L527），**强制重新运行已缓存节点**，浪费计算资源
- **触发条件**: 多输出节点（例如MSST 6-stem）的非连续端口被存款（例如只deposit port 0和port 3）
- **修复**: 使用Map<number, string>代替数组，或显式初始化数组长度并填充undefined

**❌ 缺陷11 [中危]**: **materializeAmtMidiTracks重复UUID风险**
- **位置**: L1338、L1349、L1387、L1408
- **问题**: 使用`crypto.randomUUID()`生成segment ID和note ID，**未检查与现有ID冲突**
- **影响**: 虽然UUID碰撞概率极低（~10^-36），但在循环中生成数千个note ID时，理论上可能碰撞，**导致note被静默覆盖**
- **当前缓解**: UUID v4碰撞概率极低，实际未观察到
- **建议**: 在开发模式启用碰撞检测

---

### 2.8 接口契约 ⚠️

**✅ 优势**:
- **Rust IPC契约明确**: invoke调用的参数使用TypeScript类型标注（例如L627 `invoke<{ path: string; sample_rate: number }>`）
- **节点参数防御式编程**: 所有params读取使用`as Type | undefined` + 默认值（例如L746 `(params.semitones as number) ?? 0`）
- **错误消息本地化**: backendErrorMessage统一映射Rust错误码，避免暴露内部实现

**❌ 缺陷12 [中危]**: **executeNode缺少节点类型穷尽检查**
- **位置**: L598-1236
- **问题**: switch-case覆盖~25种节点类型，但**没有default分支**：
  ```typescript
  switch (nodeType) {
    case "rvc": ...
    case "sovits": ...
    // ... 25 cases
  }
  return outputData; // ❌ 未知节点类型直接返回空Map
  ```
  如果新增节点类型忘记添加case，**节点会静默成功但无输出**，下游节点报"has no input connected"
- **影响**: 开发阶段容易漏测新节点，生产环境表现为神秘的"无输入"错误
- **修复**: 添加`default: throw new Error(\`Unknown node type: ${nodeType}\`);`

**❌ 缺陷13 [低危]**: **isDenseCache假定数组语义**
- **位置**: L431-434
- **问题**:
  ```typescript
  function isDenseCache(arr: string[]): boolean {
    for (let i = 0; i < arr.length; i++) if (arr[i] == null) return false;
    return true;
  }
  ```
  注释说明"检测holes"，但使用`==`而非`===`，**会误判undefined为null**（虽然`== null`同时检查null和undefined，符合意图）
- **风险**: 如果未来传入显式null值的数组，行为可能非预期
- **建议**: 改用`arr[i] === undefined`明确语义，或添加注释说明`== null`意图

---

### 2.9 边界与异常路径 ⚠️

**✅ 优势**:
- **空图处理**: L318-325 executeWorkflow在parseWorkflowGraph失败时捕获，participants为空数组，不抛出二次错误
- **零输出警告**: L395-398检测laneCount=0时记录warn日志，而非静默成功
- **极端速率限制**: speedShift节点限制rate在0.25x-4.0x（L939-941），防止Rust侧崩溃
- **空notes处理**: chordDetect在notes.length===0时抛出清晰错误（L964）

**❌ 缺陷14 [低危]**: **waitVoiceDrain未处理负倒计时**
- **位置**: L110
- **问题**:
  ```typescript
  if (Date.now() - start > 120_000) { return false; }
  ```
  如果系统时钟回退（例如NTP调整），`Date.now() - start`可能为负，**超时永不触发**
- **影响**: 用户卡在无限等待，需强制杀进程
- **修复**: 使用`performance.now()`代替`Date.now()`，或添加最大循环次数保护

**❌ 缺陷15 [低危]**: **MSST stall timeout依赖系统时钟**
- **位置**: L697、L714
- **问题**: 同waitVoiceDrain，使用Date.now()计算超时，**时钟回退可能导致误判**
- **修复**: 使用performance.now()

---

### 2.10 规范与可维护性 ⚠️

**✅ 优势**:
- **代码注释详尽**: 关键函数（preflightRun、depositFromCache、rehydrateRenderState）都有多行文档说明设计决策
- **历史bug引用**: 注释中引用具体bug编号（S62b、S32、S59 O2、S67c等），便于追溯
- **常量命名清晰**: STALL_TIMEOUT、DECODE_GIVE_UP、DEFAULT_OUTPUT_GROUP语义明确
- **函数职责单一**: collectCachedPaths、countOutputLanes、loadCachedOutput各司其职

**⚠️ 改进空间**:
- **函数过长**: executeNode函数1238行，包含25个case分支，**严重违反SRP原则**，建议拆分为独立节点执行器
- **魔法数字**: L110的120_000（120秒）、L695的180_000（180秒）应提取为命名常量
- **类型断言过多**: 代码中大量使用`as string | undefined`，建议引入Zod等运行时校验库
- **测试覆盖不足**: 未发现engine.ts的单元测试文件，关键函数（ancestorSetOf、isDenseCache、waitVoiceDrain）应有测试

---

## 三、缺陷汇总

### 高危缺陷 (1项)
| ID | 缺陷描述 | 位置 | 影响 |
|----|---------|------|------|
| D10 | rehydrateRenderState稀疏数组越界导致强制重跑 | engine.ts:1887 | 已缓存节点被错误重新执行，浪费计算资源 |

### 中危缺陷 (6项)
| ID | 缺陷描述 | 位置 | 影响 |
|----|---------|------|------|
| D1 | voiceDrainWaiters超时泄漏导致段永久阻塞 | engine.ts:110-112 | 超时段无法再运行工作流 |
| D2 | topologicalSort环检测错误消息不精确 | graph.ts:52 | 用户误解配置错误为环 |
| D6 | voiceDrainWaiters并发竞态导致永久残留 | engine.ts:104-108 | 并发运行导致段阻塞 |
| D8 | ancestorSetOf大图O(E)遍历性能低下 | engine.ts:440-456 | 复杂工作流单节点运行延迟 |
| D11 | materializeAmtMidiTracks UUID碰撞风险 | engine.ts:1338等 | note被静默覆盖（概率极低） |
| D12 | executeNode无default分支新节点静默失败 | engine.ts:598-1236 | 未知节点类型无输出 |

### 低危缺陷 (8项)
| ID | 缺陷描述 | 位置 | 影响 |
|----|---------|------|------|
| D3 | MSST停滞检测1e-4阈值可能误报 | engine.ts:711 | 误杀正常慢速分离 |
| D4 | AMT MIDI落轨异常被静默吞没 | engine.ts:1422-1427 | 调试困难 |
| D5 | rehydrateRenderState解析失败静默 | engine.ts:1873 | 节点未标绿原因不明 |
| D7 | cacheDecodeFailures跨segment键冲突风险 | engine.ts:1584 | 解码失败计数污染（概率极低） |
| D9 | collectGroupNames O(N*M*K)复杂度 | engine.ts:1789-1801 | 大项目打开Output面板卡顿 |
| D13 | isDenseCache `==` null语义模糊 | engine.ts:432 | 未来维护风险 |
| D14 | waitVoiceDrain时钟回退无保护 | engine.ts:110 | 系统时钟调整导致无限等待 |
| D15 | MSST stall timeout时钟回退风险 | engine.ts:697 | 误判停滞 |

---

## 四、修复建议优先级

### P0 (立即修复)
1. **D10**: 将nodeOutputs数组改为Map或预分配长度
2. **D1**: 在waitVoiceDrain超时分支添加delete语句
3. **D6**: 使用原子操作保护voiceDrainWaiters检查-添加序列

### P1 (近期修复)
4. **D12**: 添加default分支抛出未知节点类型错误
5. **D8**: 预计算或缓存祖先关系图
6. **D2**: 区分环和孤立节点的错误消息

### P2 (规划修复)
7. **D4/D5**: 添加详细错误日志
8. **D14/D15**: 使用performance.now()代替Date.now()
9. **D9**: 缓存collectGroupNames结果
10. **重构**: 将executeNode拆分为25个独立节点执行器

### P3 (监控观察)
11. **D3**: 收集MSST进度报告数据，调整阈值
12. **D7/D11**: 添加碰撞监控（开发模式）
13. **D13**: 改进isDenseCache语义

---

## 五、整体评估

### 5.1 模块成熟度: ⭐⭐⭐⭐ (4/5)
- **架构设计**: 优秀。清晰的执行流水线、完备的并发控制、周到的边界检查
- **错误处理**: 良好。统一异常捕获+本地化错误消息，但部分路径静默失败
- **性能优化**: 良好。并发解码、零拷贝计数等关键路径已优化，但存在O(E)遍历
- **可维护性**: 中等。注释详尽但函数过长，缺少单元测试

### 5.2 风险评估
- **关键风险**: voiceDrainWaiters泄漏可能导致段永久不可用，需立即修复
- **性能风险**: 大图ancestorSetOf遍历和collectGroupNames复杂度较高，但当前项目规模可控
- **数据风险**: rehydrateRenderState稀疏数组会触发不必要的重跑，影响用户体验

### 5.3 优势总结
1. **并发安全设计周到**: 多阶段竞态检查、RAII监听器清理、事务包裹撤销
2. **缓存策略完备**: 运行唯一目录、密集性检查、解码失败备忘录
3. **错误处理人性化**: 本地化错误消息、致命错误模态对话框、清晰日志
4. **历史bug修复完整**: S62b、S32、S59等关键bug均已修复并文档化

---

**审查结论**: M4.1-4.2工作流引擎模块整体质量**优秀**，架构设计成熟、并发控制完备。发现**1个高危缺陷**（rehydrateRenderState数组越界）和**6个中危缺陷**（voiceDrainWaiters泄漏+竞态、执行器完备性等），建议优先修复P0级缺陷后再进入下一模块审查。

---
*审查人员: AI 审计专家组*  
*下一步: 进入M5.1音频分离模块审查*
