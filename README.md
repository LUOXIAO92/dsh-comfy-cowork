# DSH Comfy Coworking

人类与 DSH agent 在同一块画布上协作生图 / 改图的 DeepSeek Harness 插件。

- **图片编辑**：画笔 / 橡皮 / 矩形 / 椭圆蒙版，羽化、扩展、反转，导出 ComfyUI 可直接使用的 PNG。
- **布局生图**：空白画布拉 bbox、逐框写提示词，按 MOSS-Image schema 编译成单行 layout JSON。
- **工作流**：浏览 ComfyUI 服务器上的工作流、看节点图、改参数、绑定注入、排队运行、回填结果。
- **协作**：所有提示词（包括 agent 写的）都落在插件的提示词文本框里；正向、负面各一个框。
- **布局框仅 MOSS-Image**：只有当前工作流含 `MOSSImageLayoutPrompt` / `CreateBoundingBoxes` 时才会出现布局模式。

> 需求确认稿：[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)（v1.0，已确认）。

## 安装

在本仓库目录下，让 DSH 安装这个本地 bundle：

```text
plugin_manager(action: "install_bundle", target: "/home/luoxiao/comfy/dsh-comfy-coworking")
```

然后刷新 DSH Web 页面。在输入框左侧会出现「画布」按钮，点击后在右侧栏打开 **Comfy 画布**。
右栏可以拖宽，ComfyUI 工作流图支持滚轮缩放和拖动平移。

默认连接 `http://127.0.0.1:8188`。改地址：编辑 `cordis.patch.yml` 的 `baseUrl`，或在 profile 的 patch 层覆盖 `comfy-coworking` 行的 `config.baseUrl`。

## 使用

### 1. 局部改图

1. 「画布」→ 载入图片（文件选择 / 拖拽 / 从 ComfyUI 结果回填）。
2. 选画笔、橡皮、矩形或椭圆，在图上画蒙版；滑杆调粗细、硬度、不透明度。
3. 调羽化、扩展/收缩、反转；蒙版以红色叠加显示。
4. 在「工作流」页载入一个带 `LoadImage` / `LoadImageMask` 的工作流；「注入绑定」会按节点类型和连线自动推断（要改就在节点属性里设「画布注入」）：
   - prompt → 正向提示词节点
   - image / mask → `LoadImage`（同一节点时使用带 alpha 的 RGBA）
5. 填种子，点「排队运行」；结果出现在下方，可「回填画布」继续迭代。

### 2. 空白布局（MOSS-Image）

1. 切到「布局」模式，设画布宽高（16 的倍数）。
2. 用「拉框」画 bbox；每个框选 `object` / `character` / `text`，写 caption，`text` 类再写可见文字。
3. 提示词文本框会自动变成编译后的单行 layout JSON；也可直接手改。负面提示词写在独立的「负面提示词」框里，运行时会写进连到采样器 `negative` 的文本节点。
4. 载入 MOSS layout 工作流（含 `CreateBoundingBoxes` + `MOSSImageLayoutPrompt`）后运行，插件会把 summary、bboxes、宽高注入对应节点；如果工作流只有 `CLIPTextEncode`，则直接注入编译后的 JSON。

### 3. 工作流浏览

- 「工作流」页顶部选择 ComfyUI `userdata/workflows` 下的文件 → 加载。
- 节点图：点击节点，在下方改 widget 参数；可改标题、bypass/mute（在 ComfyUI 里改后重新加载）。
- 注入映射不出现在界面上：运行时按节点类型和连线自动推断（不要自定义字段，工作流 JSON 保持纯 ComfyUI 结构）。
- 「保存」写回 ComfyUI；文件名输入框可另存。
- 「模型」列出 `/models` 目录与文件，点击复制名称到剪贴板。

### 4. Agent 协作

Agent 可调用：

| 工具 | 作用 |
|---|---|
| `comfy_coworking_state` | 读画布、提示词、框、绑定、最近运行、资产路径 |
| `comfy_coworking_health` | 检查 ComfyUI 连接与浏览器画布是否已加载 |
| `comfy_coworking_set_prompt` | 写提示词文本框（replace/append） |
| `comfy_coworking_set_layout` | 用 summary + items 替换布局并编译 |
| `comfy_coworking_upsert_box` / `remove_box` | 增改/删除 bbox |
| `comfy_coworking_set_canvas` | 设画布尺寸与模式 |
| `comfy_coworking_load_image` | 把工作区图片载入画布（可选 mask 文件） |
| `comfy_coworking_list_workflows` / `load_workflow` | 列/载入 ComfyUI 工作流 |
| `comfy_coworking_bind_workflow` | 改注入绑定 |
| `comfy_coworking_list_models` | 列模型目录/文件 |
| `comfy_coworking_run` / `run_status` / `interrupt` | 运行、查状态、取消 |
| `comfy_coworking_open_canvas` | 设置打开画布的请求（用户仍需点「画布」按钮） |

所有提示词写入都走 `document.prompt`；Agent 的提示词工具不会把内容只留在聊天里。

## 存储

每个会话工作区：

```text
<workspace>/.comfy-coworking/<sessionId>/
  document.json        # 画布、提示词、布局、工作流、运行记录
  assets/
    canvas.png         # 当前画布原图
    source.png         # 原始导入图
    mask.png           # 白=编辑区的蒙版
    canvas_rgba.png    # alpha = 1 - mask，供 LoadImage 的 MASK 输出
    run-*.png/mp4      # ComfyUI 运行产物
  runs/
```

建议把 `.comfy-coworking/` 加入项目 `.gitignore`。

## 关键兼容性说明

- ComfyUI `LoadImage` 的 `MASK` 输出是 **1 - alpha**。插件导出的 `canvas_rgba.png` 已按此反转：白色（编辑区）→ alpha 0。独立 `mask.png` 保持白色=编辑区，适合 `LoadImageMask`。
- MOSS-Image 编译格式与 `comfy_extras/nodes_moss_image.py` 逐字节一致：
  `{"summary":{"caption":...},"items":[{"label":...,"caption":...,"bbox":[y1-H/2,x1-W/2,y2-H/2,x2-W/2]}],"bbox_coord_space":"abs_centralized","bbox_format":"yxyx"}`。
- `CreateBoundingBoxes` 的 `editor_state` 是 list 类型但 API 校验把 list 当 link；插件发 `"[]"` 字符串，并通过 `bboxes` JSON 注入实际框。
- 浏览器不直连 ComfyUI（实测带 Origin 会 403）；所有请求由 DSH Host 代理。

## 开发

```bash
npm install          # esbuild + React（仅开发/测试）
npm run build        # 生成 client.js（提交到仓库）
npm test             # node:test，16 项
```

- Host：`index.js` → `lib/plugin.js`；工具在 `lib/tools.js`，路由在 `lib/routes.js`，工作流转换在 `lib/workflow.js`，MOSS 编译在 `lib/moss.js`。
- Client：`src/client/`，由 esbuild 打成 `client.js`；入口 `entry.jsx`，画布 `CanvasStage.jsx`，工作流 `WorkflowView.jsx`。
- 浏览器测试夹具：`tests/harness/`（headless Chromium 截图/画笔冒烟测试，不属于运行时包）。

## 排查

- 画布标签页出现红字：先跑 `comfy_coworking_health`。返回里的 `client` 是浏览器端心跳（`tabType/body/title/composer/slots` 都应存在），`errors` 是最近失败的浏览器请求（方法、URL、状态、错误），可直接定位是哪个接口出错。
- 改了 Host 代码（`lib/`、`index.js`）后需要重载插件：`plugin_manager` 里把 `include:comfy-coworking` 先 `set_plugin` 关掉再打开。改了 Client（`src/client/`）需要 `npm run build` 并刷新页面。
- 接口要求同源浏览器 cookie：`/health` 无 cookie 返回 401、伪造 `Origin` 返回 403 属于正常防护，不是故障。
- 画布标签页提示未绑定会话：右栏标签页需要从某个聊天里打开；从无会话的面板打开时不会发请求。

## 已知限制

- 子图工作流（subgraph）暂不支持，会明确报错。
- API 格式工作流可运行/保存，图视图只读。
- v1 单 ComfyUI 服务器；多 profile 留到后续。
- `comfy_coworking_open_canvas` 不强制切换 UI。
- 视频只做通用工作流运行与预览，不做时间轴。
- 大图蒙版全分辨率处理；4K 以上建议先缩放。

## 发布

本仓库只做本地 git 提交。**未经明确许可，不添加 remote、不 push、不发布到 GitHub。**
