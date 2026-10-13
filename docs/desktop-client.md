# TaoStudio Image Lab 桌面客户端（Tauri 2）

桌面客户端随 v0.8.0 上游升级引入（`src-tauri/`），品牌化标识：
`TaoStudio Image Lab` / `com.taostudio.image-lab` / 深链 scheme `taostudio-image-lab://`。

## 构建依赖（一次性安装）

| 依赖 | 说明 |
| --- | --- |
| Rust stable（`x86_64-pc-windows-msvc`） | `rustup-init.exe -y --default-toolchain stable-x86_64-pc-windows-msvc --profile minimal` |
| VS 2022 Build Tools | workload `Microsoft.VisualStudio.Workload.VCTools` + `--includeRecommended`（含 MSVC 编译器与 Windows 11 SDK） |
| WebView2 Runtime | Windows 11 自带；Windows 10 缺失时从 Microsoft 官网装 Evergreen Runtime |

## 更新签名密钥

应用内更新（`tauri-plugin-updater`）需要 minisign 签名。fork 自己的密钥对：

- 私钥：`%USERPROFILE%\.tauri\taostudio-image-lab.key`（**永不入库、永不外发**；无口令保护，仅限本机）
- 公钥：`%USERPROFILE%\.tauri\taostudio-image-lab.key.pub`，其内容（单层 base64）已写入
  `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`

丢失私钥 = 已发客户端无法收到签名更新，只能整包重装。换密钥必须同步改 `pubkey`。

## 本机构建

```bash
export PATH="$USERPROFILE/.cargo/bin:$PATH"
export TAURI_SIGNING_PRIVATE_KEY="$USERPROFILE/.tauri/taostudio-image-lab.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri:build
```

产物（`src-tauri/target/release/bundle/` 下）：

- `nsis/TaoStudio Image Lab_<版本>_x64-setup.exe` —— 安装包（NSIS，per-user 安装，无需管理员）
- `nsis/TaoStudio Image Lab_<版本>_x64-setup.exe.sig` —— 更新签名（随 Release 上传）

不设 `TAURI_SIGNING_PRIVATE_KEY` 时构建会在打包阶段失败（`createUpdaterArtifacts: true`）。

## 安装

- 图形安装：直接运行 setup.exe（passive 界面）
- 静默安装：`"TaoStudio Image Lab_<版本>_x64-setup.exe" /S`
- 静默卸载：安装目录下 `uninstall.exe /S`

## 发布更新（发版时）

1. `npm run tauri:build` 得到 setup.exe 与 .sig
2. 在 GitHub Release（`wanghao137/taostudio-image-lab`）上传 setup.exe + .sig
3. 编写 `latest.json` 并作为资产上传（端点指向 `releases/latest/download/latest.json`）：

```json
{
  "version": "x.y.z",
  "notes": "更新说明",
  "pub_date": "2026-10-13T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<.sig 文件内容>",
      "url": "https://github.com/wanghao137/taostudio-image-lab/releases/download/vx.y.z/TaoStudio.Image.Lab_x.y.z_x64-setup.exe"
    }
  }
}
```

## 数据与存储

- 客户端数据走 Rust SQLite（`dbTauri`），图片落应用数据目录文件系统；网页版仍走 IndexedDB（`dbWeb`）。
  两者通过 `src/lib/db.ts` 平台门面按 `isTauri` 路由，新增存储 API 必须两侧都实现或显式声明平台。
- 应用数据目录：`%APPDATA%/com.taostudio.image-lab/`。
