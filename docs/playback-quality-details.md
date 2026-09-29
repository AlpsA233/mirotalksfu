# 自动最高分辨率与多清晰度回放

## 使用方式

- 摄像头默认选择「自动最高」，默认目标帧率 30 fps。授权后读取浏览器的视频能力，尝试最大尺寸，并读取实际采集参数；最大宽高无法组成有效模式时分别探测两个维度，再按现有档位回退。拒绝授权立即停止尝试。最高指浏览器的视频采集能力，不等于手机照片传感器的标称像素。
- 入会预览、入会采集、设备切换和前后摄像头切换共享 `CameraCapture`。画质菜单下显示实际宽高及帧率。设备不支持目标帧率时，自动模式优先尺寸。
- 会中手动调整画质在当前摄像头的后续重启继续生效；换摄像头回到自动最高。关闭摄像头时选择画质只改变下次开启设置。切换失败恢复上一设备、画质和帧率；用户关闭或拒绝权限后不会再次自动采集。
- 管理员与分享回放页面均有清晰度菜单和「视频详情」。源分辨率为保留录制片段尺寸的同步 H.264/AAC MP4，各片段居中补边，画布容纳全部片段；它仍经历编码，不代表无损原始文件。总览最高档取实际合成文件尺寸。
- 默认播放源分辨率，只提供比源尺寸低的 2160p / 1440p / 1080p / 720p / 480p / 360p / 240p。按画面短边分档，菜单同时显示实际宽高；为满足 H.264 偶数尺寸要求，比例可能有不足两像素的取整差异。纯音频隐藏清晰度菜单。
- 首次选择低清版本时后台生成，当前视频继续播放。完成后使用当时最新的时间、暂停状态、倍速、音量和静音状态切换。生成失败保留当前播放并可重试；连续选择只应用最后一次。切换视角保留目标档位，源文件低于目标时使用该视角的源分辨率。下载按钮始终对应当前播放文件。
- 视频详情显示文件参数与录制来源尺寸；统计浮层打开时每秒刷新播放尺寸、播放器尺寸、缓冲、总帧数及丢帧数。不支持的字段标为「不可用」。手机面板可展开和关闭。

## 部署升级

需要 Node.js 24+、FFmpeg（libx264/AAC）及 ffprobe，沿用托管录制的路径配置。SQLite 启动时自动添加 `recording_assets` 表，无需手动迁移。历史录制首次访问才检测并生成新版源分辨率回放；旧的固定 720p 同步文件不再作为新版源文件，原始录制和旧缓存不会被批量重写。删除会议会删除整个会议目录和关联元数据。

### 发送带宽上限

新版模板将 `mediasoup.webRtcTransport.maxIncomingBitrate` 从 3,000,000 改为 100,000,000 bits/s（100 Mbps，每个发送 transport 的合计入站上限）。客户端每层编码预算为 `width × height × fps × 0.1`，限制 0.5–50 Mbps，各 simulcast 层按各自缩放尺寸计算；真实网络发送速率仍由浏览器与拥塞控制决定。原始录像继续保存 SFU 收到的编码流，录制 consumer 未指定 preferredLayers，按 mediasoup 默认请求最高可用层；设备采集尺寸与最终录制参数可能不同，以 ffprobe 文件检测为准。

已有部署的 `app/src/config.js` 不会随模板自动更新，旧文件内的 3 Mbps 限制仍生效。升级时任选一种方式：

1. 在部署环境或 `.env` 中设置 `SFU_MAX_INCOMING_BITRATE=100000000`，重启服务。环境值优先于现有配置。
2. 把现有 `config.js` 的 `mediasoup.webRtcTransport.maxIncomingBitrate` 改为 `100000000`，或按实际带宽设置其他正数。

大尺寸录制会增加上传、存储和转码成本；可在会议设置中手动降低画质。不同尺寸和方向的片段混用会形成能完整容纳它们的画布，因此可能存在明显补边。

## API 与缓存

- 管理员：`POST /api/admin/recordings/:meetingId/playback/:viewId`，JSON `{ "quality": "720p", "retry": false }`。
- 分享：`GET /api/public/recordings/:shareId/:secret/playback/:viewId?quality=720p&retry=true`。
- `viewId=composition` 表示会议总览。省略 `quality` 等同 `source`。其他值仅接受列出的服务端档位，无效值返回 400。
- 处理中返回 202，`state=processing`；已有源参数时同时返回源资源、参数和清晰度列表。就绪返回 200，包含 `assetId`、`quality`、`started_at`、`metadata`、`qualities`、可选 `posterAssetId`。失败返回 `state=failed`，显式 retry 可重新入队。
- `metadata.bitrateEstimated=true` 表示平均总码率由文件大小与时长估算。`recordingSources` 保存录制来源的显示尺寸与帧率（已考虑旋转）。
- 源版本关联轨道校验信息/时间线，会议总览关联合成版本及文件信息；低清版本还关联编码参数版本。相同版本和档位共享串行任务，临时 `.partial.mp4` 完成后原子重命名才允许播放。SQLite 保存就绪参数和任务状态；重启后复用已完成文件，中断状态可重新生成。重新合成的旧版本不能继续通过资产接口访问。
- 每次播放、下载、Range 请求仍验证管理员会话或有效分享链接。撤销分享会阻止后续文件与清晰度请求；已经下载到浏览器的字节无法远程撤回。

## 验证

自动测试：

```sh
node node_modules/mocha/bin/mocha.js 'tests/*.js'
FFMPEG_PATH=/path/to/ffmpeg FFPROBE_PATH=/path/to/ffprobe node tests/integration/playback-quality.cjs
FFMPEG_PATH=/path/to/ffmpeg FFPROBE_PATH=/path/to/ffprobe node tests/integration/recording-timeline.cjs
```

覆盖能力查询/回退/权限、编码预算、切换失败恢复、切档期间继续播放与最新状态保持、连续操作、失败重试、共享鉴权、撤销和删除。真实 FFmpeg 用例覆盖 720p、1080p、4K、竖屏、旋转、不同尺寸与帧率片段、补边、缓存复用、重启、中断恢复、会议总览失效、音频延迟和静音间隔。

浏览器验证使用 Chromium、虚拟摄像头/麦克风及 390px 移动视口；它不替代 iPhone 真机。**iPhone Safari 摄像头最高模式、前后切换、会中改画质及真实移动解码性能仍需真机验收。**

本次本地验收：181 项单元/页面/接口测试通过；真实 FFmpeg 多清晰度与音画时间线测试通过；mediasoup 仅录音回归通过。Chromium 桌面与 390px 移动视口通过播放切档、暂停/倍速/音量保留、详情布局检查，虚拟摄像头通过 4K 自动选择、手动调整、关闭时更新设置和切换失败恢复。
