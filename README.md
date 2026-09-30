# CRP Presence Builder

CRP Presence Builder is a Windows desktop app for managing Discord rich-presence activities across multiple accounts.

## Compatibility

The first distributable target is Windows x64. macOS and Linux packages are not currently provided.

## Important account warning

This app connects to Discord user accounts and may use user-account tokens and selfbot functionality. Such automation may violate Discord's Terms of Service or other applicable Discord policies and may result in account restrictions, suspension, or termination.

CRP is an independent third-party project and is not affiliated with, endorsed by, sponsored by, or officially associated with Discord Inc.

Use this software at your own risk and review Discord's current Terms of Service and applicable policies before connecting a Discord account. Nothing in this notice grants permission to use selfbots or represents that such use is authorized by Discord. This notice also does not prevent Discord from taking enforcement action against an account.

Saved account tokens are stored locally using Electron's `safeStorage`. Tokens are not included in presets. Keep your account tokens private and never include them in issues, screenshots, logs, or other public content.

## Disclaimer

The software is provided "as is" and "as available", to the maximum extent permitted by applicable law, without warranties of any kind. The project does not guarantee error-free operation, uninterrupted availability, compatibility with Discord or other services, or preservation of accounts or data.

You are responsible for determining whether your use of the software complies with applicable laws and with Discord's current Terms of Service and policies.

To the maximum extent permitted by applicable law, the project author and contributors disclaim liability for account restrictions, loss of access or data, service interruptions, or other damages arising from or related to the use of the software. Nothing in this notice excludes or limits liability that cannot legally be excluded or limited under applicable law.

## Install

Download the Windows x64 installer from the project's GitHub Releases page when a release is available. Run the installer and follow its prompts. The initial installer is unsigned, so Windows may display a SmartScreen warning until the app is signed and gains reputation. Only install builds from a release source you trust.

## Run from source

Requirements: Windows x64, Node.js 22, and npm.

```powershell
npm ci
npm run build
npm run desktop
```

## Checks and packaging

```powershell
npm run lint
npm run build
npm run package:win
```

The Windows NSIS installer is written to `release/`. It installs per user and does not require administrator permissions by default.

GitHub Actions runs lint and build checks on pushes and pull requests. The Windows packaging workflow uploads the installer as an artifact when run manually. Pushing a `v*` tag also creates a GitHub Release with the installer attached.

## Data and support

App settings and account data are stored locally in Electron's user-data directory. Use the in-app Forget action to remove a saved account token. Report bugs without including tokens or other account secrets.

This project does not yet include a license file. Until a license is chosen, public availability of the source does not grant permission to reuse or redistribute it.
