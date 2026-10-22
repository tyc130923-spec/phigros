# Phi × SEKAI · GitHub Pages 多文件版

本项目由用户提供的 `Phi_SEKAI_视频导出最终版(2).html` 拆分而来。

保留原有界面、游戏逻辑、12 首内置歌曲（46 个难度谱面）、曲绘、原始皮肤和视频导出代码。网页通过同站相对路径读取资源，不依赖第三方 CDN。首次加载资源需要联网。

## 上传 GitHub 并发布

1. 解压本 ZIP。打开文件夹，应该直接看到 `index.html`、`assets`、`css`、`js`、`workers` 和本说明。
2. 登录 <https://github.com>，打开 <https://github.com/new>。
3. 仓库名称填写 `phi-sekai`，选择 **Public**，勾选 **Add README**，点击 **Create repository**。
4. 进入仓库的 **Code** 页面，选择 **Add file → Upload files**。
5. 上传解压后的项目内容，保持所有子文件夹的原有层级。不要只上传 ZIP，也不要额外套一层项目文件夹。应在仓库首页直接看到 `index.html`。
6. 点击 **Commit changes**。如果显示超过上传数量限制，可以分两次上传 `assets` 和其余文件，保持路径不变。
7. 在仓库进入 **Settings → Pages**，将 **Source** 设为 **Deploy from a branch**，**Branch** 设为 **main**，文件夹设为 **/ (root)**，点击 **Save**。
8. 等待部署完成，在 Pages 中点击 **Visit site**。项目网址一般为 `https://你的用户名.github.io/phi-sekai/`。
9. 学校电脑打开这个 Pages 网址即可；仓库地址是代码管理页，不能代替游戏网址。学校网络是否允许访问，需要现场测试。

GitHub 网页上传限制是每个文件 25 MiB。本项目的所有文件均低于该限制；上传前不需要再次压缩或拆分。

如果已经授权 ChatGPT 的 GitHub 插件访问该仓库，可以把仓库链接发给 ChatGPT，继续上传项目。当前插件如果没有 Pages 设置接口，首次启用 Pages 仍需要按第 7 步手动完成。

## 本地预览

多文件版需要通过 HTTP/HTTPS 访问，直接双击 `index.html` 的 file:// 方式不能正常加载资源。

电脑安装 Python 后，在项目文件夹打开终端并运行：

```sh
python -m http.server 8000
```

然后访问 <http://localhost:8000/>。

## 文件用途

| 路径 | 用途 |
| --- | --- |
| `index.html` | 网页入口、原始 DOM、资源说明和授权文本 |
| `css/style.css` | 主界面样式 |
| `css/original-materials.css` | 原始材质样式 |
| `css/safari-hud.css` | Safari HUD 样式 |
| `js/app.js` | 游戏逻辑和同站资源加载 |
| `js/site-network-guard.js` | 允许同站资源请求，保留跨站请求拦截 |
| `js/vendor/` | 原文件内的音频转换、LZMA 解码依赖及原有授权头 |
| `workers/video-encoder.js` | 原视频编码线程 |
| `assets/audio/` | 原始 OGG 音乐 |
| `assets/images/` | 原始曲绘 |
| `assets/charts/` | 按歌曲分组的原始压缩谱面和元数据；加载器负责解包 |
| `assets/ui/` | 原界面的字体、背景和材质图片 |
| `assets/packs/original-skin.zip` | 原始内置皮肤 |
| `assets/manifest.json` | 资源对应关系、长度和校验值 |

## 修改与更新

- 改界面文字或结构：修改 `index.html`。
- 改外观：修改 `css` 中的样式。
- 改游戏逻辑：修改 `js/app.js`，保留引用路径。
- 更新完成后上传同路径的文件并提交，Pages 会重新发布。
- `assets/charts/*.bin` 保留原文件的压缩谱面格式，不能作为普通文本直接编辑；可使用游戏原有的谱面导入功能。
- 音乐和曲绘保持原始数据，没有重新编码或降低清晰度。
- 存档、导入谱面和已保存视频仍使用原有浏览器本地存储。换设备不会自动同步这些本地数据。
- 原 HTML 的授权及来源说明已保留。拆分本身没有改变资源的授权状态。

## 校验范围

详见 `验证说明.txt`。资源校验和代码检查不等于所有浏览器、完整游戏流程或实际视频编码均已实测。
