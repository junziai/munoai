# UtaiSynthesizer 功能增强实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现轨道右键菜单增强、MIDI专属功能、端口类型系统、merge节点和质量检测节点，提升工作流灵活性和专业性

**Architecture:** 
- 前端：React + TypeScript，增强 TrackList 组件的上下文菜单系统
- 工作流：扩展节点类型系统，添加端口类型验证机制
- Rust后端：添加音频处理命令支持（分轨质量预设、多轨混音）

**Tech Stack:** React, TypeScript, Rust (Tauri), React Flow, HTDemucs (分轨), RubberBand (变速变调)

---

## 文件结构规划

### 新增文件
- `src/types/workflow-ports.ts` - 端口类型定义和验证逻辑
- `src/lib/workflow/port-validation.ts` - 连接验证函数
- `src/components/workflow/nodes/MergeNode.tsx` - Merge节点组件
- `src/components/workflow/nodes/LufsAnalyzeNode.tsx` - LUFS分析节点组件
- `src/components/workflow/nodes/ClipDetectNode.tsx` - 削波检测节点组件
- `src/lib/audio/stem-separation.ts` - 分轨质量预设逻辑
- `src/lib/audio/audio-merge.ts` - 多轨混音逻辑
- `src/components/synth/TrackContextMenu.tsx` - 重构后的轨道菜单组件

### 修改文件
- `src/types/project.ts` - 添加新节点类型到 WorkflowNodeType
- `src/components/synth/TrackList.tsx` - 增强右键菜单
- `src/components/workflow/WorkflowEditor.tsx` - 注册新节点
- `src/components/workflow/NodePalette.tsx` - 添加新节点到面板
- `src/lib/workflow/engine.ts` - 添加新节点执行逻辑
- `src-tauri/src/commands/audio.rs` - 添加Rust命令

---

## 阶段 0：架构基础 - 端口类型系统

### Task 1: 定义端口类型系统

**Files:**
- Create: `src/types/workflow-ports.ts`
- Test: 手动验证类型定义

- [ ] **Step 1: 创建端口类型定义文件**

```typescript
// src/types/workflow-ports.ts

/**
 * 工作流端口数据类型
 */
export type PortType = 
  | 'audio'      // 音频信号
  | 'midi'       // MIDI音符数据
  | 'chords'     // 和弦进行数据
  | 'lyrics'     // 歌词文本
  | 'report'     // 分析报告(JSON)
  | 'image'      // 图像(频谱图等)
  | 'video'      // 视频
  | 'any';       // 通配类型

/**
 * 端口定义
 */
export interface PortSchema {
  id: string;           // 端口标识符 (如 'audio', 'audio_wet', 'midi_in')
  type: PortType;       // 端口类型
  label: string;        // 显示标签
  optional?: boolean;   // 是否可选
  multiple?: boolean;   // 是否接受多个连接
}

/**
 * 节点模式定义
 */
export interface NodeSchema {
  type: string;                    // 节点类型
  inputs: PortSchema[];            // 输入端口
  outputs: PortSchema[];           // 输出端口
  category: string;                // 分类
  displayName: string;             // 显示名称
  description: string;             // 描述
}

/**
 * 端口颜色映射（用于UI显示）
 */
export const PORT_COLORS: Record<PortType, string> = {
  audio: '#3b82f6',      // 蓝色
  midi: '#10b981',       // 绿色
  chords: '#f59e0b',     // 橙色
  lyrics: '#ec4899',     // 粉色
  report: '#6366f1',     // 紫色
  image: '#14b8a6',      // 青色
  video: '#ef4444',      // 红色
  any: '#9ca3af'         // 灰色
};

/**
 * 端口连接兼容性矩阵
 */
export const PORT_COMPATIBILITY: Record<PortType, PortType[]> = {
  audio: ['audio', 'any'],
  midi: ['midi', 'any'],
  chords: ['chords', 'any'],
  lyrics: ['lyrics', 'any'],
  report: ['report', 'any'],
  image: ['image', 'any'],
  video: ['video', 'any'],
  any: ['audio', 'midi', 'chords', 'lyrics', 'report', 'image', 'video', 'any']
};
```

- [ ] **Step 2: 创建连接验证逻辑文件**

```typescript
// src/lib/workflow/port-validation.ts

import type { PortSchema, PortType } from '@/types/workflow-ports';
import { PORT_COMPATIBILITY } from '@/types/workflow-ports';

export type ConnectionValidation = 
  | { valid: true }
  | { valid: false; reason: string }
  | { valid: 'warning'; reason: string };

/**
 * 验证两个端口是否可以连接
 */
export function validateConnection(
  sourcePort: PortSchema,
  targetPort: PortSchema
): ConnectionValidation {
  // 规则1: 类型兼容性检查
  const compatibleTypes = PORT_COMPATIBILITY[sourcePort.type] || [];
  if (!compatibleTypes.includes(targetPort.type)) {
    return {
      valid: false,
      reason: `类型不兼容: ${sourcePort.type} 无法连接到 ${targetPort.type}`
    };
  }

  // 规则2: 特殊转换提示
  if (sourcePort.type === 'audio' && targetPort.type === 'report') {
    return {
      valid: 'warning',
      reason: '需要插入分析节点 (如 lufsAnalyze) 来转换音频为报告'
    };
  }

  if (sourcePort.type === 'midi' && targetPort.type === 'audio') {
    return {
      valid: 'warning',
      reason: '需要插入渲染节点 (如 soundfontRender) 来转换MIDI为音频'
    };
  }

  return { valid: true };
}

/**
 * 检查端口是否接受多连接
 */
export function canAcceptMultipleConnections(port: PortSchema): boolean {
  return port.multiple === true;
}

/**
 * 获取端口的显示颜色
 */
export function getPortColor(portType: PortType): string {
  return PORT_COLORS[portType] || '#9ca3af';
}
```

- [ ] **Step 3: 提交端口类型系统基础**

```bash
git add src/types/workflow-ports.ts src/lib/workflow/port-validation.ts
git commit -m "feat: 添加工作流端口类型系统基础定义"
```

---

### Task 2: 定义核心节点的端口模式

**Files:**
- Create: `src/lib/workflow/node-schemas.ts`
- Test: 类型检查通过

- [ ] **Step 1: 创建节点模式注册表**

```typescript
// src/lib/workflow/node-schemas.ts

import type { NodeSchema } from '@/types/workflow-ports';

/**
 * 节点模式注册表
 * 定义每个节点的输入输出端口
 */
export const NODE_SCHEMAS: Record<string, NodeSchema> = {
  // === 音频处理节点 ===
  rvc: {
    type: 'rvc',
    category: 'voice',
    displayName: 'RVC变声',
    description: 'Retrieval-based Voice Conversion',
    inputs: [
      { id: 'audio', type: 'audio', label: '输入音频' },
      { id: 'f0_curve', type: 'report', label: 'F0曲线', optional: true }
    ],
    outputs: [
      { id: 'audio', type: 'audio', label: '变声后音频' }
    ]
  },

  msstSeparation: {
    type: 'msstSeparation',
    category: 'audio',
    displayName: '音轨分离',
    description: 'HTDemucs 人声/伴奏分离',
    inputs: [
      { id: 'audio', type: 'audio', label: '输入音频' }
    ],
    outputs: [
      { id: 'vocals', type: 'audio', label: '人声' },
      { id: 'drums', type: 'audio', label: '鼓组' },
      { id: 'bass', type: 'audio', label: '贝斯' },
      { id: 'other', type: 'audio', label: '其他' }
    ]
  },

  transpose: {
    type: 'transpose',
    category: 'audio',
    displayName: '变调',
    description: '音高移调处理',
    inputs: [
      { id: 'audio', type: 'audio', label: '输入音频' }
    ],
    outputs: [
      { id: 'audio', type: 'audio', label: '变调后音频' }
    ]
  },

  // === MIDI/符号域节点 ===
  amtMidi: {
    type: 'amtMidi',
    category: 'analysis',
    displayName: 'AI转谱',
    description: 'Audio to MIDI 转换',
    inputs: [
      { id: 'audio', type: 'audio', label: '输入音频' }
    ],
    outputs: [
      { id: 'midi', type: 'midi', label: 'MIDI音符' },
      { id: 'report', type: 'report', label: '转换报告' }
    ]
  },

  soundfontRender: {
    type: 'soundfontRender',
    category: 'synthesis',
    displayName: 'Soundfont渲染',
    description: 'MIDI转音频(SF2/SFZ)',
    inputs: [
      { id: 'midi', type: 'midi', label: 'MIDI输入' }
    ],
    outputs: [
      { id: 'audio', type: 'audio', label: '渲染音频' }
    ]
  },

  chordDetect: {
    type: 'chordDetect',
    category: 'analysis',
    displayName: '和弦识别',
    description: '自动识别和弦进行',
    inputs: [
      { id: 'audio', type: 'audio', label: '音频输入', optional: true },
      { id: 'midi', type: 'midi', label: 'MIDI输入', optional: true }
    ],
    outputs: [
      { id: 'chords', type: 'chords', label: '和弦数据' },
      { id: 'report', type: 'report', label: '分析报告' }
    ]
  },

  midiHumanize: {
    type: 'midiHumanize',
    category: 'midi',
    displayName: 'MIDI人性化',
    description: '添加微小随机变化',
    inputs: [
      { id: 'midi', type: 'midi', label: 'MIDI输入' }
    ],
    outputs: [
      { id: 'midi', type: 'midi', label: 'MIDI输出' }
    ]
  },

  melodySimilarity: {
    type: 'melodySimilarity',
    category: 'analysis',
    displayName: '旋律相似度',
    description: '检测旋律原创性',
    inputs: [
      { id: 'midi_test', type: 'midi', label: '待检测MIDI' },
      { id: 'midi_reference', type: 'midi', label: '参考MIDI', optional: true }
    ],
    outputs: [
      { id: 'report', type: 'report', label: '相似度报告' },
      { id: 'pass', type: 'any', label: '通过闸门' }
    ]
  },

  // === 编曲节点 ===
  autoArrange: {
    type: 'autoArrange',
    category: 'arrangement',
    displayName: '智能编曲',
    description: '自动配器11种乐器',
    inputs: [
      { id: 'midi', type: 'midi', label: '主旋律', optional: true },
      { id: 'chords', type: 'chords', label: '和弦进行', optional: true }
    ],
    outputs: [
      { id: 'midi_piano', type: 'midi', label: '钢琴' },
      { id: 'midi_bass', type: 'midi', label: '贝斯' },
      { id: 'midi_drums', type: 'midi', label: '鼓组' },
      { id: 'midi_guitar', type: 'midi', label: '吉他' },
      { id: 'report', type: 'report', label: '编曲报告' }
    ]
  }
};

/**
 * 获取节点的模式定义
 */
export function getNodeSchema(nodeType: string): NodeSchema | undefined {
  return NODE_SCHEMAS[nodeType];
}

/**
 * 获取节点的输入端口模式
 */
export function getNodeInputPorts(nodeType: string): PortSchema[] {
  const schema = NODE_SCHEMAS[nodeType];
  return schema?.inputs || [];
}

/**
 * 获取节点的输出端口模式
 */
export function getNodeOutputPorts(nodeType: string): PortSchema[] {
  const schema = NODE_SCHEMAS[nodeType];
  return schema?.outputs || [];
}
```

- [ ] **Step 2: 运行类型检查**

```bash
npm run typecheck
```

预期: 无类型错误

- [ ] **Step 3: 提交节点模式定义**

```bash
git add src/lib/workflow/node-schemas.ts
git commit -m "feat: 添加核心工作流节点的端口模式定义"
```

---

## 阶段 0：架构基础 - Merge多轨混音节点

### Task 3: 添加 merge 节点类型定义

**Files:**
- Modify: `src/types/project.ts:473-562`
- Test: 类型检查

- [ ] **Step 1: 在 WorkflowNodeType 添加 merge**

在 `src/types/project.ts` 的 `WorkflowNodeType` 联合类型中添加:

```typescript
export type WorkflowNodeType =
  // ... 现有类型 ...
  | 'merge'              // ← 新增：多轨混音节点
  | 'split'
  // ... 其他类型 ...
```

- [ ] **Step 2: 在节点模式注册表添加 merge 定义**

在 `src/lib/workflow/node-schemas.ts` 的 `NODE_SCHEMAS` 中添加:

```typescript
merge: {
  type: 'merge',
  category: 'audio',
  displayName: '多轨混音',
  description: '合并多个音频轨道',
  inputs: [
    { id: 'audio_1', type: 'audio', label: '音频1' },
    { id: 'audio_2', type: 'audio', label: '音频2' },
    { id: 'audio_3', type: 'audio', label: '音频3', optional: true },
    { id: 'audio_4', type: 'audio', label: '音频4', optional: true }
  ],
  outputs: [
    { id: 'audio', type: 'audio', label: '混音输出' }
  ]
},
```

- [ ] **Step 3: 运行类型检查验证**

```bash
npm run typecheck
```

预期: 无错误

- [ ] **Step 4: 提交类型定义**

```bash
git add src/types/project.ts src/lib/workflow/node-schemas.ts
git commit -m "feat(workflow): 添加 merge 多轨混音节点类型定义"
```

---

### Task 4: 创建 MergeNode 组件

**Files:**
- Create: `src/components/workflow/nodes/MergeNode.tsx`
- Reference: `src/components/workflow/nodes/RvcNode.tsx` (参考现有节点结构)

- [ ] **Step 1: 创建 MergeNode 组件基础结构**

```typescript
// src/components/workflow/nodes/MergeNode.tsx

import { memo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import type { WorkflowNode } from '@/types/project';
import { getPortColor } from '@/lib/workflow/port-validation';

interface MergeNodeData {
  mode?: 'mix' | 'concat';          // 混音模式: mix=叠加, concat=拼接
  volumes?: number[];                // 各轨音量 [1.0, 0.8, 0.6, 0.5]
  pans?: number[];                   // 声像 [-1左, 0中, +1右]
  normalization?: 'none' | 'peak' | 'lufs';  // 归一化方式
  targetLUFS?: number;               // 目标响度 (仅当 normalization='lufs')
}

export const MergeNode = memo(({ data, selected }: NodeProps<WorkflowNode>) => {
  const nodeData = data.params as MergeNodeData;
  const mode = nodeData?.mode || 'mix';
  const volumes = nodeData?.volumes || [1.0, 1.0, 1.0, 1.0];
  const normalization = nodeData?.normalization || 'none';

  return (
    <div
      className={`
        rounded-lg border-2 bg-white shadow-md
        ${selected ? 'border-blue-500' : 'border-gray-300'}
        min-w-[200px]
      `}
    >
      {/* 标题栏 */}
      <div className="bg-blue-50 px-3 py-2 border-b border-gray-200">
        <div className="flex items-center gap-2">
          <span className="text-lg">🎛️</span>
          <span className="font-semibold text-sm">多轨混音</span>
        </div>
        <div className="text-xs text-gray-500 mt-1">
          {mode === 'mix' ? '混音模式' : '拼接模式'}
        </div>
      </div>

      {/* 内容区域 */}
      <div className="p-3 space-y-2">
        {/* 输入端口 */}
        <div className="space-y-1">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <Handle
                type="target"
                position={Position.Left}
                id={`audio_${i}`}
                style={{
                  background: getPortColor('audio'),
                  width: 10,
                  height: 10,
                  left: -5
                }}
              />
              <span className="text-gray-600">音频{i}</span>
              {mode === 'mix' && (
                <span className="text-gray-400 ml-auto">
                  {Math.round(volumes[i - 1] * 100)}%
                </span>
              )}
            </div>
          ))}
        </div>

        {/* 归一化显示 */}
        {normalization !== 'none' && (
          <div className="text-xs text-gray-500 border-t pt-2">
            归一化: {normalization === 'peak' ? '峰值' : `${nodeData?.targetLUFS || -14} LUFS`}
          </div>
        )}
      </div>

      {/* 输出端口 */}
      <div className="px-3 pb-3">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-600">混音输出</span>
          <Handle
            type="source"
            position={Position.Right}
            id="audio"
            style={{
              background: getPortColor('audio'),
              width: 10,
              height: 10,
              right: -5
            }}
          />
        </div>
      </div>
    </div>
  );
});

MergeNode.displayName = 'MergeNode';
```

- [ ] **Step 2: 注册节点到 WorkflowEditor**

在 `src/components/workflow/WorkflowEditor.tsx` 的 nodeTypes 映射中添加:

```typescript
const nodeTypes = useMemo(
  () => ({
    // ... 现有节点 ...
    merge: MergeNode,  // ← 新增
    // ... 其他节点 ...
  }),
  []
);
```

同时在图标映射表中添加:

```typescript
const NODE_ICONS: Record<WorkflowNodeType, string> = {
  // ... 现有图标 ...
  merge: '🎛️',
  // ... 其他图标 ...
};
```

- [ ] **Step 3: 添加到节点面板**

在 `src/components/workflow/NodePalette.tsx` 的分类中添加:

```typescript
const categories = [
  {
    name: '音频处理',
    nodes: [
      // ... 现有节点 ...
      { type: 'merge', label: '多轨混音', icon: '🎛️' },
      // ... 其他节点 ...
    ]
  },
  // ... 其他分类 ...
];
```

- [ ] **Step 4: 验证节点显示**

启动开发服务器:
```bash
npm run dev
```

在工作流编辑器中:
1. 打开节点面板
2. 找到"音频处理"分类
3. 验证"多轨混音"节点可以拖拽到画布
4. 验证节点显示4个输入端口和1个输出端口

- [ ] **Step 5: 提交节点组件**

```bash
git add src/components/workflow/nodes/MergeNode.tsx src/components/workflow/WorkflowEditor.tsx src/components/workflow/NodePalette.tsx
git commit -m "feat(workflow): 实现 MergeNode 多轨混音节点UI组件"
```

---

### Task 5: 实现 merge 节点执行逻辑

**Files:**
- Modify: `src/lib/workflow/engine.ts` (添加 merge case)
- Create: `src/lib/audio/audio-merge.ts`
- Modify: `src-tauri/src/commands/audio.rs` (添加 Rust 命令)

- [ ] **Step 1: 创建音频混音逻辑**

```typescript
// src/lib/audio/audio-merge.ts

import { invoke } from '@tauri-apps/api/core';

export interface MergeOptions {
  mode: 'mix' | 'concat';
  volumes?: number[];
  pans?: number[];
  normalization?: 'none' | 'peak' | 'lufs';
  targetLUFS?: number;
}

/**
 * 合并多个音频文件
 */
export async function mergeAudioFiles(
  inputPaths: string[],
  outputPath: string,
  options: MergeOptions
): Promise<void> {
  if (inputPaths.length < 2) {
    throw new Error('至少需要2个音频输入才能合并');
  }

  // 调用 Tauri 后端的音频混音命令
  await invoke('audio_merge', {
    inputs: inputPaths,
    output: outputPath,
    mode: options.mode,
    volumes: options.volumes || inputPaths.map(() => 1.0),
    pans: options.pans || inputPaths.map(() => 0.0),
    normalization: options.normalization || 'none',
    targetLufs: options.targetLUFS || -14.0
  });
}

/**
 * 估算混音后的时长
 */
export function estimateMergedDuration(
  durations: number[],
  mode: 'mix' | 'concat'
): number {
  if (mode === 'concat') {
    return durations.reduce((sum, d) => sum + d, 0);
  } else {
    return Math.max(...durations);
  }
}
```

- [ ] **Step 2: 在 engine.ts 添加 merge 执行逻辑**

在 `src/lib/workflow/engine.ts` 的节点执行 switch 语句中添加:

```typescript
case 'merge': {
  // 获取所有输入音频
  const audioInputs: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const portId = `audio_${i}`;
    const inputData = node.inputs?.[portId];
    if (inputData && typeof inputData === 'string') {
      audioInputs.push(inputData);
    }
  }

  if (audioInputs.length < 2) {
    throw new Error(`Merge节点需要至少2个音频输入，当前只有${audioInputs.length}个`);
  }

  const params = node.params as MergeNodeData;
  const outputPath = await generateTempAudioPath('merged');

  await mergeAudioFiles(audioInputs, outputPath, {
    mode: params?.mode || 'mix',
    volumes: params?.volumes,
    pans: params?.pans,
    normalization: params?.normalization,
    targetLUFS: params?.targetLUFS
  });

  return { audio: outputPath };
}
```

- [ ] **Step 3: 添加 Rust 后端混音命令 (占位实现)**

在 `src-tauri/src/commands/audio.rs` 添加:

```rust
#[tauri::command]
pub async fn audio_merge(
    inputs: Vec<String>,
    output: String,
    mode: String,
    volumes: Vec<f32>,
    pans: Vec<f32>,
    normalization: String,
    target_lufs: f32,
) -> Result<(), String> {
    // TODO: 实现真正的音频混音逻辑
    // 当前占位实现: 简单复制第一个输入
    use std::fs;
    
    if inputs.is_empty() {
        return Err("No input files".to_string());
    }
    
    // 占位: 复制第一个文件
    fs::copy(&inputs[0], &output)
        .map_err(|e| format!("Failed to merge audio: {}", e))?;
    
    println!("Audio merge (placeholder): {} files -> {}", inputs.len(), output);
    println!("Mode: {}, Normalization: {}", mode, normalization);
    
    Ok(())
}
```

并在 `src-tauri/src/main.rs` 注册命令:

```rust
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            // ... 现有命令 ...
            audio_merge,  // ← 新增
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 4: 测试 merge 节点基本功能**

手动测试步骤:
1. 启动应用 `npm run dev`
2. 在工作流编辑器创建测试流程:
   ```
   [音频文件1] ──→ merge ──→ [输出]
   [音频文件2] ──┘
   ```
3. 执行工作流
4. 验证输出文件生成(当前会输出第一个文件的副本)

- [ ] **Step 5: 提交 merge 节点功能**

```bash
git add src/lib/audio/audio-merge.ts src/lib/workflow/engine.ts src-tauri/src/commands/audio.rs src-tauri/src/main.rs
git commit -m "feat(workflow): 实现 merge 节点执行逻辑(占位实现)"
```

---

## 阶段 1：轨道右键菜单增强

### Task 6: 重构轨道右键菜单为独立组件

**Files:**
- Create: `src/components/synth/TrackContextMenu.tsx`
- Modify: `src/components/synth/TrackList.tsx:380-499`

- [ ] **Step 1: 创建菜单类型定义**

```typescript
// src/components/synth/TrackContextMenu.tsx

import type { Track } from '@/types/project';

export interface MenuItem {
  label: string;
  icon?: string;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  children?: MenuItem[];
  separator?: boolean;
}

export interface TrackContextMenuProps {
  track: Track;
  onClose: () => void;
  position: { x: number; y: number };
}
```

- [ ] **Step 2: 实现菜单组件基础结构**

```typescript
// 继续 src/components/synth/TrackContextMenu.tsx

import { useEffect, useRef } from 'react';

export function TrackContextMenu({ track, onClose, position }: TrackContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭菜单
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const isAudioTrack = !!track.audioPath;
  const isMidiTrack = track.notes && track.notes.length > 0;

  // 构建菜单项
  const menuItems = buildMenuItems(track, isAudioTrack, isMidiTrack);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-white rounded-md shadow-lg border border-gray-200 py-1 min-w-[220px]"
      style={{ top: position.y, left: position.x }}
    >
      {menuItems.map((item, index) => (
        <MenuItemComponent key={index} item={item} onClose={onClose} />
      ))}
    </div>
  );
}

function MenuItemComponent({ item, onClose }: { item: MenuItem; onClose: () => void }) {
  const [showSubmenu, setShowSubmenu] = useState(false);

  if (item.separator) {
    return <div className="h-px bg-gray-200 my-1" />;
  }

  const hasChildren = item.children && item.children.length > 0;

  return (
    <div
      className="relative"
      onMouseEnter={() => hasChildren && setShowSubmenu(true)}
      onMouseLeave={() => hasChildren && setShowSubmenu(false)}
    >
      <button
        className={`
          w-full text-left px-3 py-2 text-sm
          hover:bg-blue-50 
          ${item.disabled ? 'text-gray-400 cursor-not-allowed' : 'text-gray-700'}
        `}
        onClick={() => {
          if (!item.disabled && item.onClick) {
            item.onClick();
            onClose();
          }
        }}
        disabled={item.disabled}
        title={item.title}
      >
        <span className="flex items-center gap-2">
          {item.icon && <span>{item.icon}</span>}
          <span>{item.label}</span>
          {hasChildren && <span className="ml-auto">▶</span>}
        </span>
      </button>

      {/* 子菜单 */}
      {hasChildren && showSubmenu && (
        <div
          className="absolute left-full top-0 ml-1 bg-white rounded-md shadow-lg border border-gray-200 py-1 min-w-[200px]"
        >
          {item.children!.map((child, idx) => (
            <MenuItemComponent key={idx} item={child} onClose={onClose} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: 提取菜单构建逻辑**

```typescript
// 继续 src/components/synth/TrackContextMenu.tsx

function buildMenuItems(
  track: Track,
  isAudioTrack: boolean,
  isMidiTrack: boolean
): MenuItem[] {
  const items: MenuItem[] = [];

  // === AI 快捷入口（音频轨道）===
  if (isAudioTrack) {
    items.push({
      label: 'AI 快捷功能',
      icon: '✨',
      children: [
        {
          label: '转MIDI (AI 转谱)',
          icon: '🎵',
          onClick: () => handleAMT(track.id),
          title: '用 AI 模型把音频转成 MIDI 音符轨'
        },
        {
          label: '一键扒带编曲',
          icon: '⚡',
          onClick: () => handleAMTWithArrange(track.id),
          title: '音频先 AI 转谱,完成后自动打开智能编曲面板'
        },
        {
          label: '识别和弦',
          icon: '🎼',
          onClick: () => handleChordDetect(track.id)
        },
        {
          label: '识别鼓点',
          icon: '🥁',
          onClick: () => handleDrumDetect(track.id)
        }
      ]
    });
  }

  // === MIDI 专属功能 ===
  if (isMidiTrack) {
    items.push({
      label: 'MIDI 编辑',
      icon: '🎹',
      children: [
        {
          label: '打开钢琴卷帘窗',
          icon: '✏️',
          onClick: () => handleOpenPianoRoll(track.id)
        },
        {
          label: '量化音符',
          icon: '🎯',
          onClick: () => handleQuantize(track.id)
        },
        {
          label: '人性化处理',
          icon: '🎲',
          onClick: () => handleHumanize(track.id)
        }
      ]
    });
  }

  // === 通用功能 ===
  items.push(
    {
      label: '智能编曲',
      icon: '✨',
      onClick: () => handleArrange(track.id),
      disabled: !isMidiTrack && !isAudioTrack
    },
    { separator: true },
    {
      label: '重命名',
      icon: '✏️',
      onClick: () => handleRename(track.id)
    },
    {
      label: '删除',
      icon: '🗑️',
      onClick: () => handleDelete(track.id)
    }
  );

  return items;
}

// 占位处理函数
function handleAMT(trackId: string) {
  console.log('AMT:', trackId);
}
function handleAMTWithArrange(trackId: string) {
  console.log('AMT + Arrange:', trackId);
}
function handleChordDetect(trackId: string) {
  console.log('Chord detect:', trackId);
}
function handleDrumDetect(trackId: string) {
  console.log('Drum detect:', trackId);
}
function handleOpenPianoRoll(trackId: string) {
  console.log('Open piano roll:', trackId);
}
function handleQuantize(trackId: string) {
  console.log('Quantize:', trackId);
}
function handleHumanize(trackId: string) {
  console.log('Humanize:', trackId);
}
function handleArrange(trackId: string) {
  console.log('Arrange:', trackId);
}
function handleRename(trackId: string) {
  console.log('Rename:', trackId);
}
function handleDelete(trackId: string) {
  console.log('Delete:', trackId);
}
```

- [ ] **Step 4: 在 TrackList 中使用新菜单组件**

在 `src/components/synth/TrackList.tsx` 中:

```typescript
import { TrackContextMenu } from './TrackContextMenu';

// 在组件内部
const [contextMenu, setContextMenu] = useState<{
  track: Track;
  position: { x: number; y: number };
} | null>(null);

// 右键处理
const handleContextMenu = (e: React.MouseEvent, track: Track) => {
  e.preventDefault();
  setContextMenu({
    track,
    position: { x: e.clientX, y: e.clientY }
  });
};

// 渲染
return (
  <>
    {/* 轨道列表 */}
    {tracks.map(track => (
      <div
        key={track.id}
        onContextMenu={(e) => handleContextMenu(e, track)}
      >
        {/* 轨道内容 */}
      </div>
    ))}

    {/* 右键菜单 */}
    {contextMenu && (
      <TrackContextMenu
        track={contextMenu.track}
        position={contextMenu.position}
        onClose={() => setContextMenu(null)}
      />
    )}
  </>
);
```

- [ ] **Step 5: 测试菜单显示**

```bash
npm run dev
```

测试步骤:
1. 右键点击音频轨道 → 验证显示"AI快捷功能"菜单
2. 右键点击MIDI轨道 → 验证显示"MIDI编辑"菜单
3. 测试子菜单悬停展开
4. 测试点击外部关闭菜单

- [ ] **Step 6: 提交菜单重构**

```bash
git add src/components/synth/TrackContextMenu.tsx src/components/synth/TrackList.tsx
git commit -m "refactor(ui): 重构轨道右键菜单为独立组件"
```

---

### Task 7: 添加一键分轨质量预设菜单

**Files:**
- Modify: `src/components/synth/TrackContextMenu.tsx`
- Create: `src/lib/audio/stem-separation.ts`

- [ ] **Step 1: 创建分轨质量预设逻辑**

```typescript
// src/lib/audio/stem-separation.ts

import { invoke } from '@tauri-apps/api/core';

export type StemQuality = 'fast' | 'standard' | 'pro' | 'best';

export interface StemSeparationOptions {
  quality: StemQuality;
  outputCount: 2 | 4 | 5 | 6;  // 输出轨道数
}

/**
 * 质量预设配置
 */
export const STEM_QUALITY_PRESETS: Record<StemQuality, {
  model: string;
  shifts: number;
  overlap: number;
  description: string;
}> = {
  fast: {
    model: 'htdemucs',
    shifts: 0,
    overlap: 0.25,
    description: '快速分轨，适合预览'
  },
  standard: {
    model: 'htdemucs',
    shifts: 1,
    overlap: 0.25,
    description: '标准质量，平衡速度和效果'
  },
  pro: {
    model: 'htdemucs_ft',
    shifts: 3,
    overlap: 0.5,
    description: '专业质量，推荐用于发布'
  },
  best: {
    model: 'htdemucs_6s',
    shifts: 5,
    overlap: 0.75,
    description: '最佳质量，处理时间最长'
  }
};

/**
 * 执行音轨分离
 */
export async function separateStems(
  inputPath: string,
  outputDir: string,
  options: StemSeparationOptions
): Promise<{ [key: string]: string }> {
  const preset = STEM_QUALITY_PRESETS[options.quality];
  
  const result = await invoke<{ [key: string]: string }>('audio_separate_stems', {
    input: inputPath,
    outputDir,
    model: preset.model,
    shifts: preset.shifts,
    overlap: preset.overlap,
    stems: options.outputCount
  });

  return result;
}

/**
 * 估算分轨处理时间
 */
export function estimateStemSeparationTime(
  durationSeconds: number,
  quality: StemQuality
): number {
  const multipliers = {
    fast: 0.5,
    standard: 1.0,
    pro: 2.5,
    best: 4.0
  };
  return durationSeconds * multipliers[quality];
}
```

- [ ] **Step 2: 在菜单中添加一键分轨子菜单**

修改 `src/components/synth/TrackContextMenu.tsx` 的 `buildMenuItems` 函数:

```typescript
// 在音频轨道菜单中添加
if (isAudioTrack) {
  items.push({
    label: '一键分轨',
    icon: '🎼',
    children: [
      {
        label: '快速分轨 (人声+伴奏)',
        icon: '⚡',
        onClick: () => handleStemSeparation(track.id, 'fast', 2),
        title: '2轨分离，快速预览 (~30秒/分钟音频)'
      },
      {
        label: '标准4轨 (人声/鼓/贝斯/其他)',
        icon: '🎵',
        onClick: () => handleStemSeparation(track.id, 'standard', 4),
        title: '标准质量，平衡效果 (~1分钟/分钟音频)'
      },
      {
        label: '专业5轨 (人声/鼓/贝斯/钢琴/其他)',
        icon: '🎹',
        onClick: () => handleStemSeparation(track.id, 'pro', 5),
        title: '专业质量，推荐发布使用 (~2.5分钟/分钟音频)'
      },
      {
        label: '高精度6轨 (HTDemucs最佳)',
        icon: '🔬',
        onClick: () => handleStemSeparation(track.id, 'best', 6),
        title: '最高质量，处理时间最长 (~4分钟/分钟音频)'
      }
    ]
  });
}

// 添加处理函数
async function handleStemSeparation(
  trackId: string,
  quality: StemQuality,
  outputCount: 2 | 4 | 5 | 6
) {
  try {
    // 获取轨道信息
    const track = getTrackById(trackId);
    if (!track?.audioPath) {
      throw new Error('轨道没有音频文件');
    }

    // 显示进度提示
    showProgressToast('正在分离音轨...', 'stem-separation');

    // 执行分轨
    const outputDir = await getTempDir();
    const result = await separateStems(track.audioPath, outputDir, {
      quality,
      outputCount
    });

    // 创建子轨道
    const stemNames = {
      vocals: '人声',
      drums: '鼓组',
      bass: '贝斯',
      piano: '钢琴',
      other: '其他',
      accompaniment: '伴奏'
    };

    for (const [stemType, stemPath] of Object.entries(result)) {
      const stemName = stemNames[stemType as keyof typeof stemNames] || stemType;
      await createTrack({
        name: `${track.name}_${stemName}`,
        audioPath: stemPath,
        parentId: trackId
      });
    }

    closeProgressToast('stem-separation');
    showSuccessToast(`成功分离为 ${outputCount} 轨`);
  } catch (error) {
    console.error('分轨失败:', error);
    showErrorToast(`分轨失败: ${error.message}`);
  }
}
```

- [ ] **Step 3: 添加 Rust 分轨命令占位**

在 `src-tauri/src/commands/audio.rs`:

```rust
#[tauri::command]
pub async fn audio_separate_stems(
    input: String,
    output_dir: String,
    model: String,
    shifts: u32,
    overlap: f32,
    stems: u32,
) -> Result<HashMap<String, String>, String> {
    // TODO: 集成 HTDemucs 或 Spleeter
    // 当前占位实现
    
    use std::collections::HashMap;
    
    println!("Stem separation (placeholder):");
    println!("  Input: {}", input);
    println!("  Model: {}, Shifts: {}, Overlap: {}", model, shifts, overlap);
    println!("  Output stems: {}", stems);
    
    // 占位: 返回虚拟路径
    let mut result = HashMap::new();
    
    match stems {
        2 => {
            result.insert("vocals".to_string(), format!("{}/vocals.wav", output_dir));
            result.insert("accompaniment".to_string(), format!("{}/accompaniment.wav", output_dir));
        }
        4 => {
            result.insert("vocals".to_string(), format!("{}/vocals.wav", output_dir));
            result.insert("drums".to_string(), format!("{}/drums.wav", output_dir));
            result.insert("bass".to_string(), format!("{}/bass.wav", output_dir));
            result.insert("other".to_string(), format!("{}/other.wav", output_dir));
        }
        5 => {
            result.insert("vocals".to_string(), format!("{}/vocals.wav", output_dir));
            result.insert("drums".to_string(), format!("{}/drums.wav", output_dir));
            result.insert("bass".to_string(), format!("{}/bass.wav", output_dir));
            result.insert("piano".to_string(), format!("{}/piano.wav", output_dir));
            result.insert("other".to_string(), format!("{}/other.wav", output_dir));
        }
        6 => {
            result.insert("vocals".to_string(), format!("{}/vocals.wav", output_dir));
            result.insert("drums".to_string(), format!("{}/drums.wav", output_dir));
            result.insert("bass".to_string(), format!("{}/bass.wav", output_dir));
            result.insert("piano".to_string(), format!("{}/piano.wav", output_dir));
            result.insert("guitar".to_string(), format!("{}/guitar.wav", output_dir));
            result.insert("other".to_string(), format!("{}/other.wav", output_dir));
        }
        _ => return Err("Invalid stem count".to_string())
    }
    
    Ok(result)
}
```

注册到 `src-tauri/src/main.rs`:

```rust
.invoke_handler(tauri::generate_handler![
    // ... 现有命令 ...
    audio_separate_stems,
])
```

- [ ] **Step 4: 测试分轨菜单**

```bash
npm run dev
```

测试:
1. 右键音频轨道
2. 悬停到"一键分轨"
3. 验证显示4个质量预设选项
4. 点击任意选项 → 验证控制台输出

- [ ] **Step 5: 提交分轨功能**

```bash
git add src/lib/audio/stem-separation.ts src/components/synth/TrackContextMenu.tsx src-tauri/src/commands/audio.rs
git commit -m "feat(track): 添加一键分轨质量预设菜单"
```

---

### Task 8: 添加 MIDI 转换质量预设

**Files:**
- Modify: `src/components/synth/TrackContextMenu.tsx`
- Create: `src/lib/audio/amt-quality.ts`

- [ ] **Step 1: 创建 AMT 质量预设定义**

```typescript
// src/lib/audio/amt-quality.ts

export type AMTQuality = 'fast' | 'standard' | 'best' | 'guitar' | 'piano';

export interface AMTOptions {
  quality: AMTQuality;
  minNoteDuration?: number;  // 最小音符时长(秒)
  hopLength?: number;        // 音频帧步长
  multiTrack?: boolean;      // 多音轨检测
}

/**
 * AMT 质量预设
 */
export const AMT_QUALITY_PRESETS: Record<AMTQuality, AMTOptions> = {
  fast: {
    quality: 'fast',
    minNoteDuration: 0.125,    // 1/8音符
    hopLength: 512,
    multiTrack: false
  },
  standard: {
    quality: 'standard',
    minNoteDuration: 0.0625,   // 1/16音符
    hopLength: 256,
    multiTrack: false
  },
  best: {
    quality: 'best',
    minNoteDuration: 0.03125,  // 1/32音符
    hopLength: 128,
    multiTrack: true
  },
  guitar: {
    quality: 'guitar',
    minNoteDuration: 0.0625,
    hopLength: 256,
    multiTrack: true,
    // TODO: 添加吉他特定参数(频率范围、泛音模式)
  },
  piano: {
    quality: 'piano',
    minNoteDuration: 0.0625,
    hopLength: 256,
    multiTrack: true,
    // TODO: 添加钢琴特定参数
  }
};

/**
 * 获取质量预设描述
 */
export function getAMTQualityDescription(quality: AMTQuality): string {
  const descriptions = {
    fast: '实时预览，快速转换',
    standard: '标准质量，平衡效果',
    best: '最佳质量，最小音符1/32',
    guitar: '吉他专用，优化六弦识别',
    piano: '钢琴专用，优化和弦识别'
  };
  return descriptions[quality];
}
```

- [ ] **Step 2: 更新菜单中的 AMT 选项**

修改 `src/components/synth/TrackContextMenu.tsx`:

```typescript
// 替换原有的单一 AMT 菜单项
{
  label: '转MIDI (AI转谱)',
  icon: '🎵',
  children: [
    {
      label: '快速转换',
      icon: '⚡',
      onClick: () => handleAMTWithQuality(track.id, 'fast'),
      title: '实时预览，适合快速检查旋律'
    },
    {
      label: '标准转换',
      icon: '🎯',
      onClick: () => handleAMTWithQuality(track.id, 'standard'),
      title: '平衡质量和速度，推荐使用'
    },
    {
      label: '高精度转换',
      icon: '💎',
      onClick: () => handleAMTWithQuality(track.id, 'best'),
      title: '最佳质量，捕获最小音符细节'
    },
    { separator: true },
    {
      label: '吉他专用模式',
      icon: '🎸',
      onClick: () => handleAMTWithQuality(track.id, 'guitar'),
      title: '优化六弦乐器识别'
    },
    {
      label: '钢琴专用模式',
      icon: '🎹',
      onClick: () => handleAMTWithQuality(track.id, 'piano'),
      title: '优化钢琴和弦识别'
    }
  ]
}

// 处理函数
async function handleAMTWithQuality(trackId: string, quality: AMTQuality) {
  try {
    const track = getTrackById(trackId);
    if (!track?.audioPath) {
      throw new Error('轨道没有音频文件');
    }

    const options = AMT_QUALITY_PRESETS[quality];
    const description = getAMTQualityDescription(quality);
    
    showProgressToast(`${description} - 正在转换...`, 'amt');

    // 调用 AMT 转换
    const result = await performAMT(track.audioPath, options);

    // 创建 MIDI 轨道
    await createMidiTrack({
      name: `${track.name}_MIDI`,
      notes: result.notes,
      parentId: trackId
    });

    closeProgressToast('amt');
    showSuccessToast(`成功转换 ${result.notes.length} 个音符`);
  } catch (error) {
    console.error('AMT失败:', error);
    showErrorToast(`转换失败: ${error.message}`);
  }
}
```

- [ ] **Step 3: 实现 AMT 调用逻辑**

```typescript
// 在 src/lib/audio/amt-quality.ts 中添加

import { invoke } from '@tauri-apps/api/core';

export interface AMTResult {
  notes: Array<{
    pitch: number;
    velocity: number;
    startTime: number;
    duration: number;
  }>;
  confidence: number;
}

/**
 * 执行 Audio-to-MIDI 转换
 */
export async function performAMT(
  audioPath: string,
  options: AMTOptions
): Promise<AMTResult> {
  const result = await invoke<AMTResult>('audio_to_midi', {
    input: audioPath,
    minNoteDuration: options.minNoteDuration,
    hopLength: options.hopLength,
    multiTrack: options.multiTrack
  });

  return result;
}
```

- [ ] **Step 4: 添加 Rust AMT 命令占位**

在 `src-tauri/src/commands/audio.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct MidiNote {
    pitch: u8,
    velocity: u8,
    start_time: f64,
    duration: f64,
}

#[derive(Serialize)]
pub struct AmtResult {
    notes: Vec<MidiNote>,
    confidence: f64,
}

#[tauri::command]
pub async fn audio_to_midi(
    input: String,
    min_note_duration: f64,
    hop_length: u32,
    multi_track: bool,
) -> Result<AmtResult, String> {
    // TODO: 集成 Basic Pitch 或其他 AMT 模型
    
    println!("AMT conversion (placeholder):");
    println!("  Input: {}", input);
    println!("  Min note: {}s, Hop: {}, Multi: {}", 
             min_note_duration, hop_length, multi_track);
    
    // 占位: 返回测试音符
    Ok(AmtResult {
        notes: vec![
            MidiNote { pitch: 60, velocity: 80, start_time: 0.0, duration: 0.5 },
            MidiNote { pitch: 64, velocity: 75, start_time: 0.5, duration: 0.5 },
            MidiNote { pitch: 67, velocity: 70, start_time: 1.0, duration: 0.5 },
        ],
        confidence: 0.85,
    })
}
```

注册命令:
```rust
.invoke_handler(tauri::generate_handler![
    // ...
    audio_to_midi,
])
```

- [ ] **Step 5: 测试 AMT 质量预设**

```bash
npm run dev
```

测试:
1. 右键音频轨道
2. 展开"转MIDI (AI转谱)"子菜单
3. 验证显示5个质量选项
4. 点击"快速转换" → 验证控制台输出和占位结果

- [ ] **Step 6: 提交 AMT 质量预设**

```bash
git add src/lib/audio/amt-quality.ts src/components/synth/TrackContextMenu.tsx src-tauri/src/commands/audio.rs
git commit -m "feat(track): 添加MIDI转换质量预设菜单"
```

---

## 阶段 1：MIDI 轨道专属右键功能

### Task 9: 添加 MIDI 编辑菜单项

**Files:**
- Modify: `src/components/synth/TrackContextMenu.tsx`
- Create: `src/lib/midi/midi-operations.ts`

- [ ] **Step 1: 创建 MIDI 操作函数**

```typescript
// src/lib/midi/midi-operations.ts

import type { Note } from '@/types/project';

/**
 * 量化音符到指定网格
 */
export function quantizeNotes(
  notes: Note[],
  gridSize: number  // 网格大小(秒), 如 0.25 = 1/4音符 @ 120BPM
): Note[] {
  return notes.map(note => ({
    ...note,
    startTime: Math.round(note.startTime / gridSize) * gridSize,
    duration: Math.round(note.duration / gridSize) * gridSize
  }));
}

/**
 * MIDI 人性化处理
 */
export function humanizeNotes(
  notes: Note[],
  options: {
    timingVariation: number;    // 时间随机范围(秒)
    velocityVariation: number;  // 力度随机范围(0-127)
  }
): Note[] {
  return notes.map(note => ({
    ...note,
    startTime: note.startTime + (Math.random() - 0.5) * options.timingVariation,
    velocity: Math.max(1, Math.min(127, 
      note.velocity + (Math.random() - 0.5) * options.velocityVariation
    ))
  }));
}

/**
 * 调整力度曲线
 */
export function applyVelocityCurve(
  notes: Note[],
  curveType: 'linear' | 'crescendo' | 'diminuendo' | 'exponential'
): Note[] {
  const noteCount = notes.length;
  
  return notes.map((note, index) => {
    let factor = 1.0;
    const progress = index / noteCount;
    
    switch (curveType) {
      case 'crescendo':
        factor = 0.5 + progress * 0.5;  // 从50%渐强到100%
        break;
      case 'diminuendo':
        factor = 1.0 - progress * 0.5;  // 从100%渐弱到50%
        break;
      case 'exponential':
        factor = Math.pow(progress, 2);
        break;
      default:
        factor = 1.0;
    }
    
    return {
      ...note,
      velocity: Math.max(1, Math.min(127, Math.round(note.velocity * factor)))
    };
  });
}
```

- [ ] **Step 2: 在菜单中添加 MIDI 编辑选项**

修改 `src/components/synth/TrackContextMenu.tsx` 的 `buildMenuItems`:

```typescript
// MIDI 轨道专属菜单
if (isMidiTrack) {
  items.push({
    label: 'MIDI 编辑',
    icon: '🎹',
    children: [
      {
        label: '打开钢琴卷帘窗',
        icon: '✏️',
        onClick: () => handleOpenPianoRoll(track.id),
        title: '在钢琴卷帘编辑器中编辑音符'
      },
      { separator: true },
      {
        label: '量化音符',
        icon: '🎯',
        children: [
          {
            label: '1/4 音符',
            onClick: () => handleQuantize(track.id, 0.5)
          },
          {
            label: '1/8 音符',
            onClick: () => handleQuantize(track.id, 0.25)
          },
          {
            label: '1/16 音符',
            onClick: () => handleQuantize(track.id, 0.125)
          },
          {
            label: '1/32 音符',
            onClick: () => handleQuantize(track.id, 0.0625)
          }
        ]
      },
      {
        label: '人性化处理',
        icon: '🎲',
        onClick: () => handleHumanize(track.id),
        title: '添加微小的时间和力度随机变化'
      },
      {
        label: '力度曲线',
        icon: '📊',
        children: [
          {
            label: '渐强 (Crescendo)',
            icon: '📈',
            onClick: () => handleVelocityCurve(track.id, 'crescendo')
          },
          {
            label: '渐弱 (Diminuendo)',
            icon: '📉',
            onClick: () => handleVelocityCurve(track.id, 'diminuendo')
          },
          {
            label: '指数曲线',
            icon: '📐',
            onClick: () => handleVelocityCurve(track.id, 'exponential')
          }
        ]
      }
    ]
  });

  // MIDI 渲染菜单
  items.push({
    label: '渲染音频',
    icon: '🔊',
    children: [
      {
        label: '用 Soundfont 渲染',
        icon: '🎹',
        onClick: () => handleSoundfontRender(track.id, 'dialog'),
        title: '选择 SF2/SFZ 音色库渲染'
      },
      {
        label: '快速渲染 (默认音色)',
        icon: '⚡',
        onClick: () => handleSoundfontRender(track.id, 'default'),
        title: '使用默认钢琴音色快速渲染'
      },
      { separator: true },
      {
        label: '导出 MIDI 文件',
        icon: '💾',
        onClick: () => handleExportMidi(track.id)
      }
    ]
  });
}

// 处理函数实现
function handleQuantize(trackId: string, gridSize: number) {
  const track = getTrackById(trackId);
  if (!track?.notes) return;
  
  const quantized = quantizeNotes(track.notes, gridSize);
  updateTrackNotes(trackId, quantized);
  showSuccessToast(`音符已量化到 ${gridSize * 2} 音符`);
}

function handleHumanize(trackId: string) {
  const track = getTrackById(trackId);
  if (!track?.notes) return;
  
  const humanized = humanizeNotes(track.notes, {
    timingVariation: 0.02,    // ±20ms
    velocityVariation: 10     // ±10
  });
  updateTrackNotes(trackId, humanized);
  showSuccessToast('已应用人性化处理');
}

function handleVelocityCurve(trackId: string, curveType: string) {
  const track = getTrackById(trackId);
  if (!track?.notes) return;
  
  const processed = applyVelocityCurve(track.notes, curveType as any);
  updateTrackNotes(trackId, processed);
  showSuccessToast(`已应用${curveType}力度曲线`);
}

function handleSoundfontRender(trackId: string, mode: 'dialog' | 'default') {
  // TODO: 调用 soundfontRender 工作流节点或直接渲染
  console.log('Soundfont render:', trackId, mode);
  showInfoToast('Soundfont 渲染功能开发中');
}

function handleExportMidi(trackId: string) {
  // TODO: 导出为标准 MIDI 文件
  console.log('Export MIDI:', trackId);
  showInfoToast('MIDI 导出功能开发中');
}
```

- [ ] **Step 3: 测试 MIDI 菜单**

```bash
npm run dev
```

测试:
1. 创建或选择一个包含 MIDI 音符的轨道
2. 右键轨道 → 验证显示"MIDI 编辑"和"渲染音频"菜单
3. 测试"量化音符"子菜单 → 验证音符被量化
4. 测试"人性化处理" → 验证音符时间和力度有随机变化
5. 测试"力度曲线" → 验证力度渐变效果

- [ ] **Step 4: 提交 MIDI 编辑功能**

```bash
git add src/lib/midi/midi-operations.ts src/components/synth/TrackContextMenu.tsx
git commit -m "feat(midi): 添加MIDI轨道专属编辑菜单(量化/人性化/力度曲线)"
```

---

## 阶段 2：质量检测节点

### Task 10: 实现 LUFS 响度分析节点

**Files:**
- Modify: `src/types/project.ts` (添加 lufsAnalyze)
- Create: `src/components/workflow/nodes/LufsAnalyzeNode.tsx`
- Modify: `src/lib/workflow/node-schemas.ts`
- Modify: `src/lib/workflow/engine.ts`

- [ ] **Step 1: 添加 lufsAnalyze 节点类型**

在 `src/types/project.ts`:

```typescript
export type WorkflowNodeType =
  // ... 现有类型 ...
  | 'lufsAnalyze'    // ← 新增
  // ...
```

在 `src/lib/workflow/node-schemas.ts`:

```typescript
lufsAnalyze: {
  type: 'lufsAnalyze',
  category: 'analysis',
  displayName: 'LUFS响度分析',
  description: 'EBU R128 / ITU-R BS.1770 响度测量',
  inputs: [
    { id: 'audio', type: 'audio', label: '输入音频' }
  ],
  outputs: [
    { id: 'report', type: 'report', label: '响度报告' },
    { id: 'audio', type: 'audio', label: '音频直通' }
  ]
},
```

- [ ] **Step 2: 创建 LufsAnalyzeNode 组件**

```typescript
// src/components/workflow/nodes/LufsAnalyzeNode.tsx

import { memo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import type { WorkflowNode } from '@/types/project';
import { getPortColor } from '@/lib/workflow/port-validation';

interface LufsNodeData {
  standard?: 'ebu-r128' | 'atsc-a85' | 'spotify' | 'youtube';
  targetLUFS?: number;
  lastResult?: {
    integratedLUFS: number;
    loudnessRange: number;
    truePeak: number;
    compliant: boolean;
  };
}

export const LufsAnalyzeNode = memo(({ data, selected }: NodeProps<WorkflowNode>) => {
  const nodeData = data.params as LufsNodeData;
  const standard = nodeData?.standard || 'ebu-r128';
  const targetLUFS = nodeData?.targetLUFS || -14;
  const result = nodeData?.lastResult;

  return (
    <div
      className={`
        rounded-lg border-2 bg-white shadow-md
        ${selected ? 'border-purple-500' : 'border-gray-300'}
        min-w-[220px]
      `}
    >
      {/* 标题栏 */}
      <div className="bg-purple-50 px-3 py-2 border-b border-gray-200">
        <div className="flex items-center gap-2">
          <span className="text-lg">📊</span>
          <span className="font-semibold text-sm">LUFS响度分析</span>
        </div>
        <div className="text-xs text-gray-500 mt-1">
          标准: {standard.toUpperCase()} | 目标: {targetLUFS} LUFS
        </div>
      </div>

      {/* 输入输出 */}
      <div className="p-3">
        <div className="flex items-center gap-2 text-xs mb-2">
          <Handle
            type="target"
            position={Position.Left}
            id="audio"
            style={{
              background: getPortColor('audio'),
              width: 10,
              height: 10,
              left: -5
            }}
          />
          <span className="text-gray-600">音频输入</span>
        </div>

        {/* 分析结果显示 */}
        {result && (
          <div className="bg-gray-50 rounded p-2 space-y-1 text-xs mb-2">
            <div className="flex justify-between">
              <span className="text-gray-600">整体响度:</span>
              <span className={`font-mono ${
                Math.abs(result.integratedLUFS - targetLUFS) < 1 
                  ? 'text-green-600' 
                  : 'text-orange-600'
              }`}>
                {result.integratedLUFS.toFixed(1)} LUFS
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">响度范围:</span>
              <span className="font-mono">{result.loudnessRange.toFixed(1)} LU</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">真峰值:</span>
              <span className="font-mono">{result.truePeak.toFixed(1)} dBTP</span>
            </div>
            <div className="flex justify-between pt-1 border-t">
              <span className="text-gray-600">合规性:</span>
              <span className={result.compliant ? 'text-green-600' : 'text-red-600'}>
                {result.compliant ? '✓ 通过' : '✗ 不合规'}
              </span>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 text-xs mb-1">
          <span className="text-gray-600">响度报告</span>
          <Handle
            type="source"
            position={Position.Right}
            id="report"
            style={{
              background: getPortColor('report'),
              width: 10,
              height: 10,
              right: -5,
              top: '50%'
            }}
          />
        </div>

        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-600">音频直通</span>
          <Handle
            type="source"
            position={Position.Right}
            id="audio"
            style={{
              background: getPortColor('audio'),
              width: 10,
              height: 10,
              right: -5,
              top: '70%'
            }}
          />
        </div>
      </div>
    </div>
  );
});

LufsAnalyzeNode.displayName = 'LufsAnalyzeNode';
```

- [ ] **Step 3: 注册节点**

在 `src/components/workflow/WorkflowEditor.tsx`:

```typescript
const nodeTypes = useMemo(
  () => ({
    // ...
    lufsAnalyze: LufsAnalyzeNode,
    // ...
  }),
  []
);

const NODE_ICONS: Record<WorkflowNodeType, string> = {
  // ...
  lufsAnalyze: '📊',
  // ...
};
```

在 `src/components/workflow/NodePalette.tsx`:

```typescript
{
  name: '分析检测',
  nodes: [
    // ...
    { type: 'lufsAnalyze', label: 'LUFS响度分析', icon: '📊' },
    // ...
  ]
},
```

- [ ] **Step 4: 实现执行逻辑**

在 `src/lib/workflow/engine.ts`:

```typescript
case 'lufsAnalyze': {
  const inputAudio = node.inputs?.audio;
  if (!inputAudio || typeof inputAudio !== 'string') {
    throw new Error('lufsAnalyze节点需要音频输入');
  }

  const params = node.params as LufsNodeData;
  const standard = params?.standard || 'ebu-r128';
  const targetLUFS = params?.targetLUFS || -14;

  // 调用 LUFS 分析
  const result = await invoke<LufsReport>('audio_analyze_lufs', {
    input: inputAudio,
    standard,
    targetLufs: targetLUFS
  });

  // 更新节点显示结果
  updateNodeParams(node.id, {
    ...params,
    lastResult: result
  });

  return {
    report: result,
    audio: inputAudio  // 直通
  };
}
```

- [ ] **Step 5: 添加 Rust 后端占位**

在 `src-tauri/src/commands/audio.rs`:

```rust
#[derive(Serialize)]
pub struct LufsReport {
    integrated_lufs: f64,
    loudness_range: f64,
    true_peak: f64,
    compliant: bool,
    suggestions: Vec<String>,
}

#[tauri::command]
pub async fn audio_analyze_lufs(
    input: String,
    standard: String,
    target_lufs: f64,
) -> Result<LufsReport, String> {
    // TODO: 集成 pyloudnorm 或 ffmpeg ebur128
    
    println!("LUFS analysis (placeholder):");
    println!("  Input: {}", input);
    println!("  Standard: {}, Target: {} LUFS", standard, target_lufs);
    
    // 占位: 模拟结果
    let integrated = -16.5;
    let compliant = (integrated - target_lufs).abs() < 1.0;
    
    let mut suggestions = Vec::new();
    if !compliant {
        let diff = target_lufs - integrated;
        suggestions.push(format!("需要{}响度 {:.1} LUFS", 
                                if diff > 0.0 { "提高" } else { "降低" },
                                diff.abs()));
    }
    
    Ok(LufsReport {
        integrated_lufs: integrated,
        loudness_range: 8.5,
        true_peak: -1.2,
        compliant,
        suggestions,
    })
}
```

注册命令:
```rust
.invoke_handler(tauri::generate_handler![
    // ...
    audio_analyze_lufs,
])
```

- [ ] **Step 6: 测试 LUFS 节点**

```bash
npm run dev
```

测试:
1. 打开工作流编辑器
2. 从节点面板拖入"LUFS响度分析"节点
3. 连接音频输入
4. 执行工作流 → 验证节点显示分析结果
5. 检查报告输出端口数据

- [ ] **Step 7: 提交 LUFS 节点**

```bash
git add src/types/project.ts src/components/workflow/nodes/LufsAnalyzeNode.tsx src/lib/workflow/node-schemas.ts src/lib/workflow/engine.ts src-tauri/src/commands/audio.rs src/components/workflow/WorkflowEditor.tsx src/components/workflow/NodePalette.tsx
git commit -m "feat(workflow): 实现 LUFS 响度分析节点"
```

---

## 验证与测试

### Task 11: 端到端测试关键功能

**Files:**
- Test: 手动测试验证

- [ ] **Step 1: 测试端口类型系统**

测试步骤:
1. 启动应用: `npm run dev`
2. 打开工作流编辑器
3. 尝试连接不兼容的端口(如 audio → midi) → 验证显示警告或阻止连接
4. 连接兼容端口(如 audio → audio) → 验证连接成功

预期结果: 端口类型验证工作正常

- [ ] **Step 2: 测试 merge 节点**

测试步骤:
1. 创建测试工作流:
   ```
   [文件输入1] ──→ merge ──→ [文件输出]
   [文件输入2] ──┘
   ```
2. 执行工作流
3. 验证输出文件生成

预期结果: Merge节点可执行(当前输出第一个文件副本)

- [ ] **Step 3: 测试音频轨右键菜单**

测试步骤:
1. 导入音频文件到轨道
2. 右键轨道 → 验证显示"一键分轨"菜单
3. 展开子菜单 → 验证显示4个质量选项
4. 点击"标准4轨" → 验证控制台输出

预期结果: 分轨菜单显示正确

- [ ] **Step 4: 测试 MIDI 转换质量预设**

测试步骤:
1. 右键音频轨道
2. 展开"转MIDI (AI转谱)" → 验证5个选项
3. 点击"高精度转换" → 验证参数传递正确

预期结果: AMT质量预设菜单工作正常

- [ ] **Step 5: 测试 MIDI 编辑功能**

测试步骤:
1. 创建或选择MIDI轨道
2. 右键 → 选择"MIDI 编辑" → "量化音符" → "1/8音符"
3. 验证音符时间被调整到1/8网格
4. 测试"人性化处理" → 验证音符有随机变化

预期结果: MIDI编辑功能正常工作

- [ ] **Step 6: 测试 LUFS 分析节点**

测试步骤:
1. 在工作流中添加 lufsAnalyze 节点
2. 连接音频输入
3. 执行工作流
4. 验证节点显示分析结果(整体响度、动态范围等)

预期结果: LUFS节点显示模拟数据

- [ ] **Step 7: 运行类型检查和构建**

```bash
npm run typecheck
npm run build
```

预期结果: 无类型错误，构建成功

---

## 后续开发建议

### 未完成功能（需要后续实施）

**高优先级:**
1. **Merge 节点真实实现** - 当前只是占位，需要集成真实的音频混音库
2. **分轨真实实现** - 集成 HTDemucs 或 Spleeter
3. **AMT 真实实现** - 集成 Basic Pitch 或其他转谱模型
4. **LUFS 真实实现** - 集成 pyloudnorm 或 ffmpeg ebur128
5. **Soundfont 渲染** - 实现 MIDI-to-Audio 转换

**中优先级:**
6. **削波检测节点** (clipDetect)
7. **相位相关性检测** (phaseCorrelation)
8. **频谱分析节点** (spectrogram, spectralCompare)
9. **A/B对比节点** (abCompare)
10. **乐谱显示系统** (分屏视图 + VexFlow渲染)

**低优先级:**
11. **节点组/子图** (group/subgraph预设系统)
12. **条件路由节点** (conditionalRoute)
13. **并行处理链节点** (parallelChain)

### 技术债务
- 所有 Rust 命令当前都是占位实现，需要逐个替换为真实实现
- 端口类型验证尚未在UI层强制执行
- 需要添加错误处理和用户友好的错误提示
- 需要添加进度条和取消功能（长时间处理）

### 测试覆盖
- 添加单元测试（端口验证、MIDI操作函数）
- 添加集成测试（工作流执行）
- 添加E2E测试（关键用户流程）

---

## 实施总结

本计划覆盖了以下核心功能：

✅ **阶段0 - 架构基础** (Tasks 1-5)
- 端口类型系统定义
- 连接验证逻辑
- Merge多轨混音节点

✅ **阶段1 - 轨道菜单增强** (Tasks 6-9)
- 重构右键菜单为独立组件
- 一键分轨质量预设
- MIDI转换质量预设
- MIDI专属编辑功能

✅ **阶段2 - 质量检测** (Task 10)
- LUFS响度分析节点

✅ **验证测试** (Task 11)
- 端到端功能测试

**预计工作量:** 约 3-5 个工作日（包含测试和调试）

**关键里程碑:**
1. 端口类型系统完成 → 解锁后续所有节点开发
2. Merge节点完成 → 工作流多轨混音能力
3. 菜单增强完成 → 用户体验显著提升
4. LUFS节点完成 → 质量保证基础设施

