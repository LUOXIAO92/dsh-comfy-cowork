# DSH Comfy Coworking 需求确认稿

- 版本：v1.0（已确认）
- 日期：2026-10-30
- 状态：需求已确认；第一版按本稿实现。接口事实均已在本机 DSH / ComfyUI 0.41.0 上核对。

## 1. 产品定位

一个安装在 DSH 里的插件，把「图片编辑画布 + ComfyUI 工作流浏览器 + Agent 协作」放进同一个界面。
它不是独立 Web 应用，也不替换 DSH：聊天在左，画布在右，人和 agent 对同一份画布状态工作。

核心主张：

1. **画布是共享状态**，不是聊天附件。人画的蒙版、拉的框、写的提示词，agent 能读到；agent 写的提示词，人能在文本框里看到并继续改。
2. **产物直接可喂 ComfyUI**。蒙版是 ComfyUI 能吃的 PNG；提示词是 MOSS-Image 能直接当 conditioning 的字符串；工作流是 ComfyUI 自己保存的 workflow。
3. **本地优先**。图片只在本机、DSH 和用户配置的 ComfyUI 之间流动，不上传第三方。

## 2. 需求逐条确认

| # | 原始需求 | 本稿理解 | 状态 |
|---|---|---|---|
| R1 | 第一版主功能是图片编辑工具箱 | 图像模式：导入图片、画布缩放平移、画笔/矩形/椭圆蒙版、撤销重做、蒙版运算、导出 | 确认 |
| R2 | 可调粗细笔尖手绘蒙版；矩形/椭圆蒙版；羽化降低边缘感 | 画笔大小/硬度/不透明度/橡皮；矩形/椭圆；羽化半径、扩展/收缩、反转；蒙版叠加预览 | 确认，细节见 §4 |
| R3 | 空白画布拉 bbox，在矩形上写提示词，用于 MOSS-Image 生图 | 布局模式：设置画布尺寸，拉框、拖动/缩放、逐框 caption/text/label；实时编译为 MOSS-Image layout prompt | 确认，细节见 §5 |
| R4 | 提示词一律写进插件的提示词 text box，包括 DSH agent 写的 | 插件只有一个权威提示词文本框；人类的输入、agent 的工具写入、bbox 编译结果都落到同一个 `prompt` 字段 | 确认，细节见 §6 |
| R5 | 蒙版、提示词兼容 ComfyUI；MOSS-Image 提示词助手按 schema 来 | 蒙版输出 RGBA PNG（alpha）+ 独立 mask PNG；提示词输出 ComfyUI `MOSSImageLayoutPrompt` 同款编译结果；同时可导出 `CreateBoundingBoxes` 的 elements JSON | 确认，细节见 §5、§7 |
| R6 | 加载 ComfyUI 工作流，让用户查看、修改 | 从 ComfyUI `userdata/workflows` 列表加载，也可导入本地 JSON；节点图可视化；改节点参数、标题、bypass/mute；保存回服务器或导出 | 确认，编辑深度待定（Q1） |
| R7 | 从 ComfyUI 服务器拉模型列表 | 读 `/models`、`/models/{folder}` 和 `/object_info` 的动态 combo，节点里的模型下拉直接可选 | 确认 |
| R8 | 相当于把 ComfyUI 工作流浏览器内置进 DSH | 右侧栏标签页 + 可全屏；节点图、参数、绑定、运行、历史、结果回填 | 确认，面板位置待定（Q2） |

## 3. 第一版范围（建议）

### 3.1 做

- **DSH 集成**：一个 bundle（Host + Client），右侧栏标签页；聊天与画布并排；可全屏。
- **图像模式**
  - 图片来源：文件选择、拖拽、粘贴、从 ComfyUI 历史结果回填、agent 指定工作区路径。
  - 画布：缩放、平移、适应窗口、像素坐标显示；原图分辨率与显示分辨率分离。
  - 蒙版：画笔（大小/硬度/不透明度）、橡皮、矩形、椭圆、撤销/重做、清空、反转、羽化、扩展/收缩、显示/隐藏叠加、叠加颜色与不透明度。
  - 导出：带 alpha 的 RGBA PNG；独立黑白 mask PNG；可选 `mask` 目录。
- **布局模式**
  - 空白画布宽高（MOSS 要求 16 的倍数），bbox 新建/拖动/缩放/删除/复制/层级。
  - 每框字段：`label`（object / character / text）、`caption`、`text`（text 类必填）、可选 `tags` / `palette`。
  - 实时编译 MOSS-Image layout prompt 到提示词框；提示词框可手动编辑。
  - 校验：画布尺寸、框越界、负宽高、text 类空文本。
- **提示词面板**
  - 一个权威 textarea；辅助的 "Summary / 选中框" 编辑区；复制、格式化、校验状态。
  - agent 写入时若用户正在编辑，不静默覆盖：提示「agent 已更新」并提供载入。
- **ComfyUI 连接**
  - 可配置 base URL（默认 `http://127.0.0.1:8188`）、超时、可选 Bearer token。
  - 健康检查、队列状态、模型列表、object_info 缓存。
- **工作流**
  - 列表：服务器 userdata 下的 workflow；本地 JSON 导入；另存/覆盖/导出。
  - 视图：节点卡片、连线、pan/zoom、fit、节点搜索、参数编辑、标题编辑、bypass/mute。
  - 绑定：提示词节点、图片节点、蒙版节点、宽高节点（自动推断 + 手动覆盖）。
  - 运行：UI workflow → API prompt 转换；上传图片/蒙版；注入提示词；排队；轮询状态；取消。
  - 结果：输出缩略图、查看大图、回填画布、作为下次输入。
- **Agent 协作工具**
  - 读画布状态、写提示词、增改 bbox、读写工作流绑定、列工作流/模型、运行、取结果。
  - 所有提示词写入 `document.prompt`（即 UI 文本框），不允许只把提示词留在聊天里。
- **持久化**
  - 每个会话工作区：`.comfy-cowork/sessions/<sessionId>/`，含 `document.json`、`canvas.png`、`mask.png`、`runs/`。
  - 原子写；自动保存；刷新/重启后恢复。

### 3.2 第一版不做

- 专门的视频编辑器（时间轴、多轨、剪辑）。通用工作流如果能跑视频，可以运行和预览，但不做视频编辑 UI。
- 完整自由的节点图编辑（任意增删节点、任意连线）——待 Q1 确认；默认只做「看图 + 改参数 + 存盘」。
- Comfy Cloud、多服务器账号体系。v1 单服务器；多 profile 放 v1.1。
- 模型下载/删除/目录管理。
- 多人实时协作；v1 是「一个人 + 本机 agent」。
- 自动抠图/深度/姿态等智能蒙版；用 ComfyUI 节点解决，不内建模型。

## 4. 图片编辑与蒙版规格

- 蒙版语义：**白色/不透明 = 可编辑区域**，默认；支持「反转」切换。
- 画笔：
  - 大小 1–500 px（按原图像素计），滑杆 + 快捷键 `[` `]`。
  - 硬度 0–100%（软边用径向渐变或多次低透明度叠加）。
  - 不透明度 1–100%。
  - 橡皮 = 在蒙版上擦除；`Alt` 临时切换。
- 形状：矩形、椭圆；拖拽创建，`Shift` 约束正方形/圆；创建后可撤销。
- 后续（v1.1）：套索、多边形、魔棒、从 bbox 生成蒙版、蒙版布尔运算。
- 羽化：0–128 px 高斯模糊；扩展/收缩 -128–128 px；先扩展再羽化。
- 预览：红色/自定义色叠加，透明度可调；可隐藏蒙版只看原图。
- 导出：
  1. `mask.png`：灰度/黑白，白=编辑区。
  2. `canvas_rgba.png`：原图 RGB + alpha=mask，供 `LoadImage` 的 `MASK` 输出直接使用。
  3. 运行时可只上传需要的那个。
- 兼容性说明：ComfyUI 常见的 `LoadImage` 从 alpha 取 mask；`LoadImageMask` 从颜色通道取 mask。两种文件都提供，工作流绑定里选。

## 5. 空白画布 / bbox / MOSS-Image 规格

### 5.1 已核实的 MOSS-Image 实际接口（本机 ComfyUI 0.41.0）

核心节点 `MOSSImageLayoutPrompt`（`comfy_extras/nodes_moss_image.py`）：

- 输入：`prompt`（整图描述）、`element`（来自 `CreateBoundingBoxes`）、`width`、`height`、`character_boxes`。
- 输出：单行 JSON 字符串：

```json
{
  "summary": { "caption": "<整图描述>" },
  "items": [
    { "label": "object", "caption": "...", "bbox": [y1-H/2, x1-W/2, y2-H/2, x2-W/2] }
  ],
  "bbox_coord_space": "abs_centralized",
  "bbox_format": "yxyx"
}
```

- `text` 类 item 额外带 `"text": "..."`；有调色板时带 `"palette": [...]`。
- 坐标取整规则：`floor(y1*H/1000)-H//2`、`floor(x1*W/1000)-W//2`、`ceil(y2*H/1000)-H//2`、`ceil(x2*W/1000)-W//2`。
- 该字符串直接进 `CLIPTextEncode` 的 `text`，就是 MOSS-Image 的 conditioning；`moss_template.json` 正是这么接的。
- `CreateBoundingBoxes` 的 `bboxes` 输入接受 JSON 字符串：`[{type:"obj"|"text", bbox:[ymin,xmin,ymax,xmax] (0–1000), text?, desc?, color_palette?}]`。

### 5.2 插件行为

- 提示词文本框默认显示**编译后的单行 layout JSON**，可直接复制到 ComfyUI 的 `CLIPTextEncode`。
- 当用户没有拉框时，文本框就是普通 caption（纯文本），不强行包 JSON。
- 每个 bbox 的 caption 是 `items[i].caption`；`text` 类 item 的可见文字单独编辑。
- 提供「同步到工作流」：
  - 若绑定的是 `MOSSImageLayoutPrompt`：把 summary 写进 `prompt`，把 boxes 转成 elements 写进上游 `CreateBoundingBoxes.bboxes` 的 JSON，并写 `width/height`。
  - 若绑定的是 `CLIPTextEncode`：直接把编译后的字符串写进 `text`。
- 编译用 JS 实现，逐字节对齐 `nodes_moss_image.py` 的取整；用 Python 原节点做黄金测试。

## 6. 提示词单一来源

`document.prompt` 是唯一权威提示词。写入途径：

1. 用户在文本框直接输入/粘贴。
2. 用户拉框/改 caption 后自动编译（布局模式下）。
3. Agent 调工具写入（`comfy_coworking_set_prompt` / `comfy_coworking_set_layout` 等）。

约束与交互：

- Agent 的提示词工具**只能**写 `document.prompt`（以及结构化的 `summary` / box captions），返回结果里回显最终文本。
- 人类正在输入时，agent 更新不抢焦点：显示「Agent 更新了提示词」条，点一下载入；或在文本框未聚焦时自动同步。
- 所有写入带 `rev`，客户端乐观并发；冲突时以「最新写入 + 可回滚」处理。
- 运行工作流时，注入的是文本框当前内容；如果用户手动改了编译后的 JSON，就按用户改的发，不重新编译覆盖。

## 7. ComfyUI 兼容与工作流规格

### 7.1 连接

- 默认 `http://127.0.0.1:8188`；Host 侧代理，浏览器不直连。
  - 已实测：带 `Origin: http://127.0.0.1:3080` 直连 ComfyUI 返回 403；因此由 DSH Host 代理是必要且更稳的方案。
- 用到的接口：
  - `GET /system_stats`、`GET /models`、`GET /models/{folder}`
  - `GET /object_info`、`GET /object_info/{class}`
  - `GET /userdata?dir=workflows&recurse=true&full_info=true`、`GET/POST/DELETE /userdata/{file}`
  - `POST /upload/image`
  - `POST /prompt`、`GET /history/{prompt_id}`、`GET /queue`、`POST /interrupt`
  - `GET /view?filename=&subfolder=&type=`
- 模型下拉值以 `object_info` 的 combo options 为准；`/models/{folder}` 用于独立模型浏览器/刷新。

### 7.2 UI workflow → API prompt

- 支持两种输入：
  - ComfyUI 前端保存的 UI 格式（`nodes` / `links` / `widgets_values`）。
  - API 格式（`{ "1": {class_type, inputs}, ... }`），直接使用。
- 转换覆盖：widget 参数、link、`Reroute`、`Primitive`、`Note`、bypass（mode 4）、mute（mode 2）、seed 的 `control_after_generate` 附加 widget。
- v1 遇到 subgraph/未知自定义节点时明确报错并指出节点，不静默丢节点。
- 转换结果先做本地校验（必填输入、节点存在、类型匹配），再提交 `/prompt`。

### 7.3 绑定

工作流跑之前需要知道「把什么注入哪里」：

| 角色 | 注入内容 | 自动推断 | 手动覆盖 |
|---|---|---|---|
| prompt | 提示词文本框内容 | `CLIPTextEncode` 标题含 positive/提示词；MOSS layout 节点 | 下拉选节点 |
| image | 画布原图（ComfyUI 上传名） | `LoadImage` 第一个 | 下拉 |
| mask | RGBA 图或独立 mask | `LoadImage` 的 mask / `LoadImageMask` | 下拉 |
| width/height | 画布尺寸 | `Empty*LatentImage` / `MOSSImageLayoutPrompt` | 下拉 |

- 绑定按工作流保存，存进 `document.workflow.bindings`。
- 没有匹配节点时允许「仅运行工作流」并在结果里提示哪些角色没注入。

## 8. Agent 工具（草案）

工具名统一前缀 `comfy_coworking_`，全部通过 Host 的 session 文档工作。

| 工具 | 作用 | 关键约束 |
|---|---|---|
| `comfy_coworking_state` | 读当前画布：尺寸、模式、图片路径、框、提示词、选中框、绑定、最近运行 | 只读 |
| `comfy_coworking_set_prompt` | 写提示词文本框 | 只能写 `document.prompt`；返回最终文本 |
| `comfy_coworking_set_layout` | 用结构化 summary + items 替换布局并编译 | 校验 MOSS schema；同步写 prompt |
| `comfy_coworking_upsert_box` / `remove_box` | 增改/删 bbox | 像素坐标；自动编译 |
| `comfy_coworking_load_image` | 把工作区图片载入画布 | 路径必须在工作区 |
| `comfy_coworking_list_workflows` / `load_workflow` | 列/载入 ComfyUI 工作流 | 只读 + 当前文档 |
| `comfy_coworking_list_models` | 列模型 | 支持 folder 过滤 |
| `comfy_coworking_run` | 运行当前工作流 | 需已绑定；返回 run id/prompt_id |
| `comfy_coworking_run_status` | 查状态/结果 | 返回输出路径、错误 |
| `comfy_coworking_open` | 请求 UI 打开面板 | 客户端轮询/ SSE 响应 |

- Host 在系统提示里加一节：涉及本插件生图时，提示词必须走这些工具写进文本框，不要在聊天里给一份、插件里留空。
- Agent 读画布图：`state` 返回 `canvasPath`，agent 可再用 `read_image` 看；避免每次工具结果都塞大图。

## 9. 架构（建议）

```
DSH Web UI
  └─ Client half (React)
       ├─ sidebar.right.pane.tab  "Comfy Canvas"（聊天并排）
       ├─ 画布层：image + mask canvas + bbox layer
       ├─ 提示词/布局面板；工作流图视图；运行/历史
       └─ fetch /api/comfy-cowork/* + SSE

DSH Host
  ├─ agent tools (comfy_coworking_*)
  ├─ session document store（内存 + JSON 原子写）
  ├─ SSE 广播（doc 变更 / run 进度）
  ├─ ComfyUI 代理（fetch，无浏览器 CORS）
  ├─ 图片/蒙版资产（workspace/.comfy-cowork/...）
  └─ workflow 转换 / prompt 编译（JS，可单测）
```

关键决策：

- **状态在 Host**，因为 agent 工具必须能写、UI 刷新后要能恢复、SSE 要能广播。
- **图片字节不进 document JSON**，只存路径和元数据。
- **不用 iframe 嵌 ComfyUI**：主题、鉴权、跨域都不合适；自建节点图视图。
- **不引第三方前端库**（v1）：Canvas 2D + React；避免打包器和体积问题。若 Q1 选完整图编辑，再评估 litegraph。

## 10. 非功能要求

- 主题：只用 `--dsw-alias-*` token；暗色/亮色都可读。
- 国际化：zh + en；所有 UI 文案走 locale。
- 性能：
  - 大图显示用缩略图，蒙版和导出用原图分辨率。
  - `object_info` 缓存 + 手动刷新；工作流列表分页不做（数量少）。
  - SSE 而非高频轮询；运行状态 1s 一次。
- 可靠性：
  - 文档写入原子（tmp + rename）；损坏时从 `.bak` 恢复。
  - ComfyUI 断连时 UI 可继续编辑，恢复后重连。
  - 运行失败保留错误信息和节点 id。
- 隐私：无遥测；图片只发配置的 ComfyUI；日志不打印提示词全文（可选 debug）。
- 测试：
  - 单测：MOSS 编译器（对 Python 黄金样本）、UI→API 转换（moss_template / qwen edit / 手写边界）。
  - 集成：真实 ComfyUI 起工作流（可 mock `/prompt` 响应）。
  - 手测：画笔/形状/羽化/撤销；右栏并排；刷新恢复；agent 写提示词。

## 11. 里程碑

| 阶段 | 内容 | 可验收 |
|---|---|---|
| M0 | 需求确认、仓库/文档、插件骨架安装到本 profile | DSH 里能看到空面板 |
| M1 | 连接 + 模型列表 + 工作流列表/加载/图视图（只读） | 能浏览本机 moss_template |
| M2 | 画布图像模式：导入、画笔/矩形/椭圆、羽化、撤销、导出 | 导出的 RGBA 能被 ComfyUI LoadImage 读 |
| M3 | 布局模式 + MOSS 编译 + 提示词面板 | 编译结果与 `MOSSImageLayoutPrompt` 一致 |
| M4 | 运行链路：UI→API、绑定、上传、排队、结果回填 | 用 qwen edit / moss 实际出一张图 |
| M5 | Agent 工具 + SSE 同步 + 系统提示 | agent 写提示词后 UI 立即出现 |
| M6 | 工作流参数编辑/保存、错误处理、i18n、主题、测试 | 全流程可用 |
| M7 | README/安装说明/示例工作流、打包检查 | 可复制安装 |

## 12. 已确认决策

| 问题 | 结论 |
|---|---|
| Q1 工作流编辑深度 | **A. 看图 + 改参数/标题/bypass + 保存**；v1 不做任意增删节点和重新连线。 |
| Q2 面板位置 | **A. 右侧栏标签页，聊天并排，可全屏**。 |
| Q3 默认工作流 | **A. 不内置模板，从 ComfyUI 服务器加载**；用 `moss_template.json`、`coworking_smoke.json`、`coworking_inpaint.json`、`coworking_moss_layout.json` 做兼容性验证。 |
| Q4 局部编辑工作流 | 通用工作流 + 绑定；已验证 SDXL `VAEEncodeForInpaint` 链路。 |
| Q5 Agent 能力 | **A. 读写画布 + 写提示词/bbox + 跑工作流 + 看结果**；运行仍可见、可取消。 |
| Q6 MOSS 提示词形态 | **A. 文本框始终放最终编译后的单行 layout JSON**；旁边编辑 summary / 逐框 caption。 |
| Q7 视频 | **A. 不做视频 UI；已有视频工作流可加载、运行、预览输出**。 |

## 13. 实现状态（截至 2026-10-31）

在真实 DSH 页面（自动登录的 headless Chromium，同一个 `dsh web` 进程）里逐项验证：

- **右栏 tab**：输入框「画布」按钮打开右侧标签页（实测宽 691–709px），新版编辑器版面：左侧工具轨、中间画板 + 状态栏、右侧可折叠检查器。
- **画布数据**：本会话 agent 写入的 MOSS layout prompt（675 字符）出现在提示词文本框；画布图与 3 个 bbox 正确显示，无报错。
- **蒙版链路**：真实页面里画笔描边 → `PUT /asset?name=mask.png` 200 → `PUT /doc/canvas` 200 → 文档 `mask.hasMask=true`、`assets/mask.png` 落盘，状态栏显示「蒙版就绪」。
- **工作流浏览**：真实 ComfyUI 的 workflow 列表 → 加载 `coworking_smoke.json`，渲染 13 个节点 / 15 条连线；注入绑定按节点类型与连线自动推断（`#104 moss-image Positive`、`#106 EmptyFlux2LatentImage`、`#116 KSampler`）。手动映射改成节点上的 `ccw` 字段，写在工作流 JSON 里，不再有外挂映射表。
- **模型列表**：`/models` 返回 checkpoints / configs / loras / vae / text_encoders，选 checkpoints 后列出真实文件名。
- **真实出图**：MOSS-Image 文生图、MOSS layout（bbox 注入）、SDXL inpaint（蒙版注入）均出图。
- **单测 25 项**：MOSS 编译、工作流转换、文档存储、HTTP 路由（鉴权、body-only session、错误记录）。

本轮修复：

- 路由在读取请求体之前就校验 session，导致所有把 sessionId 放在 body 的写接口（提示词/布局/画布/框/选择/运行）一律 400；改为先读 body 再校验，并补了回归测试。
- 路由鉴权改为 `connection.admit()`（Host/Origin 信任 + 浏览器 cookie），无 cookie 401、伪造 Origin 403。
- 客户端加构建指纹（`x-ccw-build`），`/health` 的 `errors[]` 记录失败请求的 URL、body 与 build，便于分辨旧页面。
- 视觉改版：PS/GIMP 式分区 + ComfyUI 图编辑器密度，全部使用 DSH 主题 token。

仍建议人工扫一眼：

- 新版面在你屏幕上的手感（字体、间距、配色）。
- 大工作流图在窄栏中的可读性：自动适配后约 28%–43%，可滚轮缩放、拖动平移、点「适应」重算。

## 14. 已知限制

- 子图（subgraph）工作流暂不支持，会给出明确报错。
- API 格式工作流可以运行/保存，但图视图只读。
- 单 ComfyUI 服务器；多 profile 留到 v1.1。
- `comfy_coworking_open_canvas` 不会从 Host 强制打开浏览器 tab。
- 视频只做通用工作流运行与 `<video>` 预览，不做时间轴。
- 大图蒙版在浏览器内以全分辨率处理；4K 以上建议先缩放。
