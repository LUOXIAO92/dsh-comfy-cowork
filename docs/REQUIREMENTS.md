中文 · [English](REQUIREMENTS.en.md) · [日本語](REQUIREMENTS.ja.md)

# DSH Comfy协同 产品需求

- 版本：v1.0（已确认）；本文描述 v1.0 的行为。

## 1. 产品定位

DSH Comfy协同 是装在 DSH 里的插件，把图片编辑画布、ComfyUI 工作流浏览器和 agent 协作放进同一个界面。聊天在左，画布在右，人和 agent 对同一份画布状态工作。

1. **画布是共享状态**，不是聊天附件。人画的蒙版、拉的框、写的提示词，agent 能读；agent 写的提示词，人能在文本框里看到并继续改。
2. **产物直接进 ComfyUI**。蒙版是 ComfyUI 能读的 PNG；提示词是 MOSS-Image 能直接用的字符串；工作流是 ComfyUI 自己保存的 JSON。
3. **本地优先**。图片只在本机、DSH 和用户配置的 ComfyUI 之间流动。

插件按会话生效。装好后默认休眠；在某个聊天里运行 `/dsh-comfy-cowork`（菜单行显示名 `DSH Comfy协同`）才打开画布，并把 `comfy_coworking_*` 工具挂到该会话的 agent 上。关闭画布标签页即卸下这些工具；开关状态存进文档，刷新或重启后保持。其他聊天看不到这些工具。

## 2. 功能范围

图像模式：导入图片、缩放/平移/适应窗口、画笔/橡皮/矩形/椭圆蒙版、撤销/重做、蒙版运算、导出。

布局模式（仅 MOSS-Image）：设置画布尺寸、拉框与拖动缩放、逐框编辑 `label`/`caption`/`text`/`palette`/`tags`、实时编译布局提示词、尺寸与框的校验。

提示词：一个权威正向文本框和一个负面文本框。人工输入、agent 工具写入、布局编译结果都落在同一个 `prompt` 字段；负面提示词单独保存，运行时写进采样器连着的 negative 文本节点。

评论：在图上拉框写批注，记录作者（`user` / `agent`）。批注存进文档并嵌入导出的 PNG；agent 读批注时同时拿到该区域的截图。

工作流：列出并加载 ComfyUI `userdata/workflows` 与本地 JSON；节点图、参数、标题、bypass/mute 编辑；保存回服务器或导出；注入绑定；排队运行、取消、结果回填画布。模型列表来自 ComfyUI 的 `/models`、`/models/{folder}` 和 `object_info` 的 combo，节点里的模型下拉直接可选。

持久化：每个会话的工作区目录 `.comfy-cowork/<sessionId>/`，含 `document.json`、图片与蒙版资产、`runs/`。写入原子化，刷新或重启后恢复。

第一版不做：视频编辑 UI（时间轴、多轨、剪辑）；任意增删节点或重新连线；Comfy Cloud 与多服务器账号；模型下载、删除、目录管理；多人实时协作；内建抠图、深度、姿态等智能蒙版（交给 ComfyUI 节点）。

## 3. 画布与蒙版

- 蒙版语义：白色/不透明 = 可编辑区域；提供「反转」开关。
- 画笔：大小 1–400 px（按原图像素计）、硬度 0–100%、不透明度 1–100%；`[` `]` 调大小，`Alt` 临时切橡皮。
- 形状：矩形、椭圆；拖拽创建，`Shift` 约束正方形/圆，创建后可撤销。
- 蒙版运算：先扩展/收缩（−128–128 px），再羽化（0–128 px 高斯模糊）；可清空。叠加预览用红色或自选颜色、透明度可调，也可隐藏只看原图。
- 导出：`mask.png`（灰度，白=编辑区）与 `canvas_rgba.png`（原图 RGB + alpha=蒙版）。ComfyUI 的 `LoadImage` 从 alpha 取 mask，`LoadImageMask` 从颜色通道取 mask；两种文件都提供，由工作流绑定选择。

## 4. MOSS-Image 布局

ComfyUI 0.41.0 的实际接口：节点 `MOSSImageLayoutPrompt` 接收 `prompt`、`element`、`width`、`height`、`character_boxes`，输出单行 JSON：

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

- 框坐标先按 0–1000 归一化，再转像素：`floor(y1*H/1000)-H//2`、`floor(x1*W/1000)-W//2`、`ceil(y2*H/1000)-H//2`、`ceil(x2*W/1000)-W//2`。编译逐字节对齐 Python 节点的取整规则。
- `text` 类 item 额外带 `"text"`；有调色板时带 `"palette"`，最多 5 个颜色。
- `CreateBoundingBoxes` 的 `bboxes` 接受 JSON 字符串：`[{type:"obj"|"text", bbox:[ymin,xmin,ymax,xmax] (0–1000), text?, desc?, color_palette?}]`。
- 没有框时，文本框放普通 caption，不包 JSON；有框时放编译后的单行 JSON。
- 校验画布尺寸（16 的倍数）、框越界、负宽高、`text` 类空文本。校验失败时面板显示错误，且不用这份布局生成提示词。

## 5. 提示词单一来源

`document.prompt` 是唯一权威提示词。写入途径只有三条：用户在文本框输入、布局变化后自动编译、agent 调用提示词工具。

- agent 的提示词工具只写 `document.prompt`（以及结构化的 summary 与逐框 caption），结果回显最终文本，不允许只在聊天里给一份。用户正在输入时，agent 的更新不抢焦点：显示「agent 已更新」提示，由用户载入。
- 所有写入带 `rev`；运行工作流时注入文本框当前内容。用户手改过的编译结果按用户版本发送，不重新编译覆盖。

## 6. ComfyUI 兼容

- HTTP 前缀 `/api/comfy-cowork`。默认连接 `http://127.0.0.1:8188`，由 DSH Host 代理，浏览器不直连；带 `Origin: http://127.0.0.1:3080` 直连 ComfyUI 返回 403，Host 代理是必要路径。用到的接口：`system_stats`、`models`、`models/{folder}`、`object_info`、`userdata`（workflows 的读写删）、`upload/image`、`prompt`、`history/{prompt_id}`、`queue`、`interrupt`、`view`。
- 提示词文本、画布图、蒙版、画布宽高、种子按绑定注入；运行前做本地校验（必填输入、节点存在、类型匹配），再提交 `/prompt`。

工作流转换覆盖：widget 参数、连线、`Reroute`、`Primitive`、`Note`、bypass（mode 4）、mute（mode 2）、seed 的 `control_after_generate` 附加 widget。API 格式的工作流直接使用。遇到 subgraph 或未知自定义节点时明确报错并指出节点，不静默丢节点。

绑定按工作流保存，写在 `document.workflow.bindings`；没有匹配节点时允许只运行工作流，并在结果里说明哪些角色没有注入。

| 角色 | 注入内容 | 自动推断 |
|---|---|---|
| prompt | 提示词文本框内容 | `CLIPTextEncode` 标题含 positive/提示词；MOSS layout 节点 |
| image | 画布原图的上传名 | `LoadImage` 的第一个 |
| mask | RGBA 图或独立蒙版 | `LoadImage` 的 mask 输出 / `LoadImageMask` |
| width/height | 画布尺寸 | `Empty*LatentImage` / `MOSSImageLayoutPrompt` |

## 7. Agent 工具

工具统一前缀 `comfy_coworking_`，全部通过 Host 的会话文档工作：

- 读：`state`（画布、框、提示词、绑定、最近运行、资产路径）、`health`（连接与诊断）。
- 提示词与布局：`set_prompt`、`set_layout`、`upsert_box`、`remove_box`。
- 画布：`load_image`（仅限工作区路径）、`set_canvas`。
- 工作流与模型：`list_workflows`、`load_workflow`、`list_models`、`bind_workflow`。
- 运行：`run`、`run_status`、`interrupt`。
- 批注：`comments`（列出、新增、更新、删除，返回区域截图路径）。
- 面板：`open_canvas`（在已打开的前端页面里拉起画布标签页）。

Host 的系统提示要求：生图相关提示词必须通过这些工具写进文本框。`state` 返回画布与蒙版的绝对路径，agent 用读图工具查看，避免每次工具结果都塞大图。

## 8. 非功能要求

- 主题：只用 `--dsw-alias-*` token，暗色与亮色都可读；所有 UI 文案走 locale：中文、英文、日文；其余语言回退英文。
- 性能：显示用缩略图，蒙版与导出用原图像素；`object_info` 缓存加手动刷新；文档变更走 SSE；运行状态每秒轮询一次。
- 可靠性：文档原子写（临时文件 + rename）；文档损坏时备份并重建；ComfyUI 断连时画布仍可编辑；运行失败保留错误与节点 id。无遥测；图片只发用户配置的 ComfyUI；日志默认不打印提示词全文。
- 测试：38 个 `node:test` 单测，覆盖 MOSS 编译、工作流转换、文档存储、HTTP 路由；真实 ComfyUI 上手工验证出图（MOSS 文生图、MOSS 布局、SDXL inpaint）。

## 9. 已确认决策

- 工作流编辑深度：看图、改参数/标题/bypass、保存；不做任意增删节点与重新连线。
- 面板位置：右侧栏标签页，聊天并排，可全屏。
- 默认工作流：不内置模板，从 ComfyUI 服务器加载；用 `moss_template.json`、`coworking_smoke.json`、`coworking_inpaint.json`、`coworking_moss_layout.json` 验证兼容性。
- 局部编辑：通用工作流加绑定；SDXL `VAEEncodeForInpaint` 是参考链路。
- agent 能力：读写画布、写提示词与框、跑工作流、看结果；运行可见、可取消。
- MOSS 提示词形态：文本框放最终编译的单行 layout JSON，summary 与逐框 caption 在旁边的编辑区改。
- 视频：不做视频编辑 UI；现有视频工作流可以加载、运行、预览输出。

## 10. 已知限制

- 子图工作流不支持，会明确报错；API 格式工作流可以运行和保存，但图视图只读。
- 只接一个 ComfyUI 服务器。
- agent 的 `open_canvas` 只在已打开的前端页面里拉起标签页；页面未打开时不会补开。
- 视频只做通用工作流运行与 `<video>` 预览，没有时间轴。
- 浏览器内按原图分辨率处理蒙版；4K 以上的图先缩放。
