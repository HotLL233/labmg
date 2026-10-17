# 第三方组件与许可

本清单对应 0.3.3 的 `package-lock.json`。版本及下载完整性以锁文件为准；安装包内的第三方文件保持原样，本项目没有复制上游业务代码。完整许可正文保留在 [licenses/](licenses/)，源码包包含该目录，Docker 镜像也应包含本文件与该目录。第三方组件的许可不等于对本项目作相同许可授权。

## npm 依赖

| 组件 | 固定版本 | 用途 | 许可与完整正文 |
| --- | --- | --- | --- |
| [write-excel-file](https://www.npmjs.com/package/write-excel-file/v/4.1.1) | 4.1.1 | 服务端 XLSX 导出 | [MIT](licenses/npm/write-excel-file-4.1.1-MIT.txt) |
| [fflate](https://www.npmjs.com/package/fflate/v/0.8.3) | 0.8.3 | XLSX ZIP 压缩 | [MIT](licenses/npm/fflate-0.8.3-MIT.txt) |
| [zxing-wasm](https://www.npmjs.com/package/zxing-wasm/v/3.1.5) | 3.1.5 | 浏览器本地条码解码及 QR 生成 | 包装代码 [MIT](licenses/zxing-wasm/MIT-zxing-wasm.txt)，内含其他许可见下表 |
| [@types/emscripten](https://www.npmjs.com/package/@types/emscripten/v/1.41.6) | 1.41.6 | zxing-wasm 类型依赖，不作为浏览器脚本加载 | [MIT](licenses/npm/types-emscripten-1.41.6-MIT.txt) |
| [type-fest](https://www.npmjs.com/package/type-fest/v/5.10.0) | 5.10.0 | zxing-wasm 类型依赖，不作为浏览器脚本加载 | MIT 或 CC0-1.0；保留 [MIT](licenses/npm/type-fest-5.10.0-MIT.txt) 及 [CC0](licenses/npm/type-fest-5.10.0-CC0.txt) 原文 |
| [tagged-tag](https://www.npmjs.com/package/tagged-tag/v/1.0.0) | 1.0.0 | type-fest 类型依赖，不作为浏览器脚本加载 | [MIT](licenses/npm/tagged-tag-1.0.0-MIT.txt) |

以上正文逐字节复制自对应已安装锁定包的许可文件，保留原版权声明。zxing-wasm npm 包仅附包装层 `LICENSE`；其 README 还明确列出 ZXing-C++、C++ 桥接代码与 Zint 的不同许可，不能仅凭包元数据中的 MIT 忽略内含组件。

## zxing-wasm 内含组件

| 组件与来源 | 核验的版本或提交 | 许可与完整正文 |
| --- | --- | --- |
| [zxing-wasm C++ 桥接代码](https://github.com/Sec-ant/zxing-wasm/tree/v3.1.5/src/cpp) | v3.1.5；源文件标注 Copyright 2016 Nu-book Inc.、2023 Axel Waggershauser、2023 Ze-Zheng Wu | [Apache-2.0](licenses/zxing-wasm/Apache-2.0-wrapper.txt)，正文取自该标签的 `src/cpp/LICENSE` |
| [ZXing-C++](https://github.com/zxing-cpp/zxing-cpp/tree/2ecec3f5be0ee803f6e14a5a2c7028c0cfe525b4) | `2ecec3f5be0ee803f6e14a5a2c7028c0cfe525b4`，由 v3.1.5 的 git 子模块指向核验 | [Apache-2.0](licenses/zxing-wasm/Apache-2.0-zxing-cpp.txt)，取自该提交的 `LICENSE` |
| [Zint 编码后端](https://github.com/zint/zint/tree/55541e139e62b9209b71cd9b0ba9010cec28b1d9/backend) | `55541e139e62b9209b71cd9b0ba9010cec28b1d9`，由上述 ZXing-C++ 子模块指向核验；`zint.h` 标为 2.16.0 | [BSD-3-Clause](licenses/zxing-wasm/BSD-3-Clause-zint.txt)，保留 `backend/zint.h` 的完整许可及 Copyright 2009–2025 Robin Stuart；另附[项目由 GPL 改为后端 BSD 的原文](licenses/zxing-wasm/LICENSE-zint-origin.txt)。本项目未引入 Zint 的 GPL 图形前端 |
| [stb 图像读取与写入](https://github.com/nothings/stb) | v3.1.5 的 CMake 和桥接源码明确引用 `stb_image.h` / `stb_image_write.h`；构建配置未固定 stb revision，npm 成品未提供可核验的具体提交 | 上游 MIT 或 Unlicense 双选；随附[完整原文](licenses/zxing-wasm/LICENSE-stb.txt)，保留 Copyright 2017 Sean Barrett，采用其中 MIT 选项 |

zxing-wasm 的[官方许可清单](https://github.com/Sec-ant/zxing-wasm/blob/v3.1.5/README.md#licenses)、[构建配置](https://github.com/Sec-ant/zxing-wasm/blob/v3.1.5/src/cpp/CMakeLists.txt)、子模块树及 npm tarball 的 SHA-512 完整性已核对。此记录说明已确认的来源，不将 npm 二进制视为具有完整、可复现的上游构建清单；stb 的具体构建提交没有证据时不作推测。

## 本地资源与解析边界

浏览器按需访问同源的 `/vendor/zxing-wasm/3.1.5/index.js` 与 `/vendor/zxing-wasm/3.1.5/zxing_full.wasm`，服务端分别映射锁定包的 `dist/iife/full/index.js`（40,157 字节）及 `dist/full/zxing_full.wasm`（1,546,749 字节）。未修改这些依赖文件，也不把另一份副本放入 `src/`。`material-scan.js` 覆盖库默认的 CDN `locateFile`，运行时无需访问 jsDelivr 或其他扫码服务。

摄像画面、照片与选择的图片只在当前浏览器的 Canvas/WebAssembly 中解析，不上传图像；后续业务 API 接收识别出的文本，并继续执行登录、权限、来源单和批次核对。识别不会自动验收入库或发放。摄像头仅在用户点击后请求，关闭、识别成功、切页或进入后台时停止视频轨道；晚到的授权流也会被停止。实时相机需要安全上下文（通常为 HTTPS）；普通 HTTP、权限拒绝、相机不可用或库加载失败时保留选图与手动输入入口。HTTP 能否从文件选择器调用系统拍照由浏览器和系统决定。

同一个解码库覆盖 QR、Code128、Code39、EAN13、EAN8、UPC-A、UPC-E 和 DataMatrix，避免依赖浏览器覆盖不一致的原生 `BarcodeDetector`。文件最大 20 MiB；图片长边缩至不超过 2,000 像素，实时帧不超过 1,280 像素，细小、反光或模糊条码可能需要靠近、重新拍摄或裁剪。现代 iOS Safari、Android Chrome 的实际相机权限、对焦和识别效果仍需实机验证；上游编译最低版本及桌面测试不能代替实机支持结论。

识别结果保留解码器返回的原始文本，不把编码转成数字、不删前导零、不改大小写。EAN/UPC 物理等价条码在混合识别时可能返回 13 位 EAN13 表示，例如 UPC-A `012345678905` 的图像可能返回 `0012345678905`。绑定时以扫码所得文本为准；手输/API 按精确文本匹配，不猜测别名或跨物资自动匹配。
