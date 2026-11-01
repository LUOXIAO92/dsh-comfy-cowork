# DSH Comfy Cowork

[English](README.md) · 中文 · [日本語](README.ja.md)

在 DSH 右侧栏打开一块画布，人和 agent 共用同一份画布状态，直接对接 ComfyUI。

- 画布是共享状态，不是聊天附件：人画的蒙版、拉的框、写的提示词，agent 能读到；agent 写的提示词落在同一个输入框里。
- 产物直接喂 ComfyUI：蒙版是 ComfyUI 能读的 PNG，布局是 MOSS-Image 能直接当 conditioning 的 JSON，工作流就是 ComfyUI 自己保存的那份。
- 本地优先：图片只在浏览器、DSH 和本机 ComfyUI 之间流动。

界面语言：中文、English、日本語。其他语言回退到英文。

## 演示

### Agent 写提示词、搭工作流

![Agent 写提示词并打开工作流](docs/media/agent.gif)

提示词写进插件提示词框，不会只留在聊天里；工作流页能浏览节点图、选中节点改参数。

### 局部修正：手绘精确蒙版

![手绘画笔蒙版](docs/media/mask.gif)

画笔、橡皮、矩形、椭圆画同一张蒙版；羽化、扩展、反转之后导出 ComfyUI 可直接使用的 PNG。

### 布局编排（MOSS-Image）

![拉框并编译 MOSS 布局](docs/media/layout.gif)

空白画布拉框，逐框写 caption 和可见文字，提示词框实时变成编译后的单行 layout JSON。整图描述也是一个框：拉一个框，类型选 `summary`，在那里写整体画面——只能有一个。

### 评论批注

![在图上写评论批注](docs/media/comment.gif)

在图上圈出问题、写下改法；agent 读这一块的截图和文字，按批注改图。

## 安装

在 DSH 的「插件」页面点「添加插件」，输入包名 `dsh-comfy-cowork`，安装源保持默认的「npm 官方源」，点安装。

安装包带着构建好的客户端文件：装插件的机器不需要 Node，不需要构建，也不需要放行安装脚本。

刷新 DSH 页面，在聊天里输入 `/dsh-comfy-cowork`。右侧栏打开画布，同时把这个会话的 `comfy_cowork` 工具接到该会话的 agent 上。其它会话看不到这个工具。

关闭画布不会带走工具：模型看到的工具列表保持不变，前缀缓存继续命中。右侧检查器里「画布工具」一节的移除按钮才会移除工具，点之前会先警告——工具列表一变，整段对话要重新处理一次且不命中缓存。对话较长时，先压缩再卸载。

默认连接 `http://127.0.0.1:8188`。改地址在画布里：侧栏「ComfyUI」一节填新地址，保存后写进 `<workspace>/.comfy-cowork/config.json`，插件立刻切换，不用重启。同一工作区的会话和 agent 工具都用这个地址。

## 用法

建议在会话一开始就打开画布。对话进行到一半再开启工具，会改写请求前缀，整段对话要重算一次、不再命中缓存，所以已有消息的会话会先弹确认框。确实要中途开启的话，先压缩一次对话。

### 局部改图

1. 在画布载入图片：文件选择、拖拽、粘贴，或从 ComfyUI 的结果回填。
2. 用画笔、橡皮、矩形或椭圆画蒙版；调粗细、硬度、不透明度。
3. 调羽化、扩展/收缩、反转。蒙版以红色叠加显示。
4. 在「工作流」页载入包含 `LoadImage` / `LoadImageMask` 的工作流。注入绑定按节点类型和连线自动推断；要覆盖时在节点属性里设「画布注入」。
5. 填种子，点「排队运行」。结果出现在下方，可以「回填画布」继续迭代。

### 空白布局（MOSS-Image）

1. 切到「布局」模式，设画布宽高（MOSS 要求 16 的倍数）。
2. 用「拉框」画 bbox；每个框选 `object` / `character` / `text`，写 caption，`text` 类再写可见文字。整图描述也是其中一个框：把类型设为 `summary`（只能有一个），在那里写整体画面，而不是写在提示词框里。
3. 提示词框自动变成编译后的 layout JSON，也可以手改。负面提示词写在独立的框里，运行时注入连到采样器 `negative` 的文本节点。
4. 载入含 `CreateBoundingBoxes` + `MOSSImageLayoutPrompt` 的工作流后运行。只有 `CLIPTextEncode` 时，插件直接注入编译后的 JSON。画布宽高会写进决定 latent 尺寸的节点，出图分辨率就是画布分辨率。

布局框只对 MOSS-Image 有意义；anima、SDXL 等模型用提示词框跑普通工作流。

### 模型与工作流

agent 浏览模型和浏览文件一样：`list_models` 功能先返回文件夹（`checkpoints`、`loras`、`vae`……）和文件数量，再按文件夹返回文件。这些文件名就是节点里该填的值——`Illustrious/model.safetensors`，不带文件夹前缀，也不是绝对路径。清单缓存在 `.comfy-cowork/models.json`，只在缺失时、ComfyUI 地址变化后、或 `refresh` 功能（以及画布里的「刷新目录」按钮）要求时重建，不再按计时器过期。

节点目录 `.comfy-cowork/nodes.json` 按 ComfyUI 自己的节点面板组织成分类树：先看顶层分类和数量，再进子分类，最后是归在该分类下的节点；也可以按类型、显示名、分类、描述搜索。它只存名字和描述，不存输入 schema。这棵树同样由 `refresh` 功能（或「刷新目录」按钮）重建，ComfyUI 地址变化时也会重新读取，不按计时器过期。`node_info` 功能实时从 ComfyUI 读取某个节点类型的定义——输入、默认值、范围、提示，以及每页 100 个的下拉选项——所以 schema 不会过期。

工作流有三个来源，`list_workflows` 会一起列出：ComfyUI 自己的 `userdata/workflows`、comfy 技能的项目约定（`fragments/*.json`、`blueprints/*.compiled.json`），以及本插件保存在 `.comfy-cowork/workflows` 的。保存默认写工作区，另存为可以选择写回 ComfyUI。

### Agent 协作

插件只注册一个工具 `comfy_cowork`，用三个动作取代过去每个能力一个工具：

- `discover`——不带其它参数时列出五个功能组；`group` 展开一组，`query` 搜索名称、别名（中英文）和描述。
- `describe`——返回一个或多个功能的输入 schema。
- `execute`——用一个 `arguments` 对象运行某个功能。

功能的 schema 只出现在 `describe` 的结果里，不会进入请求的工具列表。第一次调用大致是这样：

```text
comfy_cowork {"action": "discover"}
comfy_cowork {"action": "discover", "group": "canvas"}
comfy_cowork {"action": "describe", "features": ["set_prompt"]}
comfy_cowork {"action": "execute", "feature": "set_prompt", "arguments": {"prompt": "…"}}
```

知道功能名之后，单用 `execute` 就够了。五个功能组：

| 组 | 功能 | 负责 |
|---|---|---|
| `canvas` | `state`、`open_canvas`、`set_canvas`、`set_prompt`、`set_layout`、`upsert_box`、`remove_box`、`comments`、`load_image` | 读画布、改画布 |
| `workflow` | `bind_workflow`、`list_workflows`、`load_workflow`、`save_workflow` | 浏览、载入、绑定、保存工作流 |
| `runs` | `run`、`run_status`、`interrupt` | 排队、跟踪、取消运行 |
| `catalog` | `list_models`、`list_nodes`、`node_info`、`refresh` | 浏览模型与节点类型、重建缓存 |
| `misc` | `health` | 连接、版本、最近的错误 |

所有提示词写入都落在 `document.prompt`，也就是用户看到的那个输入框。

## 存储

```text
<workspace>/.comfy-cowork/<sessionId>/
  document.json        # 画布、提示词、布局、工作流、运行记录
  assets/
    canvas.png         # 当前画布原图
    source.png         # 原始导入图
    mask.png           # 白 = 编辑区
    canvas_rgba.png    # alpha = 1 - mask，供 LoadImage 的 MASK 输出
    run-*.png/mp4      # 运行产物
  runs/
```

## 兼容性

- ComfyUI `LoadImage` 的 `MASK` 输出是 **1 - alpha**。`canvas_rgba.png` 已按此反转；`mask.png` 保持白色 = 编辑区，适合 `LoadImageMask`。
- MOSS 编译逐字节对齐 `comfy_extras/nodes_moss_image.py`：
  `{"summary":{"caption":…},"items":[{"label":…,"caption":…,"bbox":[y1-H/2,x1-W/2,y2-H/2,x2-W/2]}],"bbox_coord_space":"abs_centralized","bbox_format":"yxyx"}`。
- 整图描述是类型为 `summary` 的布局项，只能有一个；它不会出现在 `items` 里，文字填进 `summary.caption`，画布上的框只是承载文字的手柄，MOSS 不用它的位置和大小。
- `CreateBoundingBoxes` 的 `editor_state` 是 list 类型但 API 校验把 list 当 link；插件发 `"[]"` 字符串，实际框走 `bboxes` JSON。
- 浏览器不直连 ComfyUI：带 `Origin` 的请求会得到 403。所有请求由 DSH Host 代理。

## 开发

```bash
npm install     # esbuild + React，仅开发与测试
npm run build   # 生成 client.js（已 gitignore，构建产物）
npm test        # node:test，100 项
```

- Host：`index.js` → `lib/plugin.js`；工具在 `lib/tools.js`，路由在 `lib/routes.js`，工作流转换在 `lib/workflow.js`，MOSS 编译在 `lib/moss.js`。
- Client：`src/client/`，由 esbuild 打成 `client.js`；入口 `entry.jsx`，画布 `CanvasStage.jsx`，工作流 `WorkflowView.jsx`。
- 浏览器夹具在 `tests/harness/`，不属于运行时包。
- 改了 Host 代码后，用 `plugin_manager` 把 `include:comfy-cowork` 关掉再打开。改了 Client 代码后重新构建并刷新页面。
- 本地开发安装：`plugin_manager(action: "install_bundle", target: "/path/to/dsh-comfy-cowork")`。
- `client.js` 是构建产物，不提交；clone 后 `npm install` 会通过 `prepare` 自动构建。
- 发布：`npm publish`。`prepack` 会先构建 `client.js` 并跑测试，发布包里带的是构建产物。

需求文档：[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)。

## 限制

- 子图工作流会明确报错，暂不支持。
- API 格式的工作流可以运行和保存，但图视图只读。
- 单个 ComfyUI 服务器；多 profile 留到后续版本。
- 视频只做通用工作流运行与预览，不做时间轴。
- 大图蒙版按全分辨率处理；4K 以上建议先缩小画布。

## 致谢

界面设计使用了 [ui-ux-pro-max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) 技能；文档写作使用了 [Agent Toolkit](https://github.com/softaworks/agent-toolkit) 的 `writing-clearly-and-concisely` 技能。

## 许可

MIT。见 [LICENSE](LICENSE)。
