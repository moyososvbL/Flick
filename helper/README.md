# Flick for Windows

Lets your paired phone control this laptop: battery, screenshot, lock/sleep/restart/shut down,
media & volume, slides, open apps, trackpad and keyboard.

## Install
1. Download **Flick.exe** from this repo's Releases → *Flick for Windows*.
2. Open it once. (If Windows SmartScreen shows "Windows protected your PC": **More info → Run anyway**.)
3. Allow it when Windows Firewall asks.

That's it — it installs itself and starts with Windows, silently.

## Pair your phone
Open Flick on your phone → **Devices** → tap your laptop → a box pops up on the laptop with a code.
If the code matches the phone, click **Yes**.

## Security
- Only phones you approve on the laptop can control it.
- Each phone gets its own secret key; every command is encrypted, signed, time-stamped and can't be replayed.
- A phone can only press Flick's buttons — it can't run programs or read files.
- Windows shows a notification when a phone takes a screenshot, locks, restarts or shuts down the laptop.
- Remove a phone anytime: Flick on the laptop → Devices → Forget.

## Uninstall
Win+R → `%LOCALAPPDATA%\Flick\Flick.exe --uninstall`, then delete the `%LOCALAPPDATA%\Flick` folder.
