# DSH Comfy Coworking

人类与 DSH agent 在同一块画布上协作生图 / 改图的 DeepSeek Harness 插件。

- 图片编辑：画笔 / 矩形 / 椭圆蒙版，羽化、扩展、反转，直接送给 ComfyUI。
- 布局生图：空白画布拉 bbox、逐框写提示词，按 MOSS-Image schema 编译提示词。
- 工作流：浏览 ComfyUI 服务器上的工作流、查看节点图、改参数、排队运行、回填结果。
- 协作：所有提示词（包括 agent 写的）都落在插件的提示词文本框里。

> 状态：需求确认中，尚未开始实现。当前文档见 [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)。

开发约定：

- 本仓库只在本机提交；**未经明确许可不添加 remote、不 push、不发布到 GitHub**。
- 用户图片、蒙版、运行产物存放在各个会话工作区的 `.comfy-coworking/` 下，不进入本仓库。
