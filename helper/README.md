# Flick Helper (Windows)

Lets your laptop:
- show your **iPhone screen** (iPhone → Screen Mirroring → Flick)
- take **shortcuts from your phone** (next slide, volume, lock, open Chrome…)

## One-time setup
1. **Bonjour** (lets the iPhone see the laptop): install *Bonjour Print Services for Windows* from Apple's support site.
2. **UxPlay** (the screen receiver): go to github.com/leapbtw/uxplay-windows → Releases →
   download **uxplay-windows-installer-v1.72.1-3.exe** (a 1.x version, not 2.x) → install it.
3. Make your Wi-Fi **Private**: Settings → Network & internet → Wi-Fi → your network → **Private network**.

## Every time
Double-click **Start Flick Helper.bat** and keep the window open.
When Windows Firewall asks, tick **Private networks** → **Allow** (it may ask for both Node and uxplay).

## Mirror your iPhone
iPhone: swipe down from the top-right → **Screen Mirroring** → **Flick** → type the code shown on the laptop.
To stop: same place → **Stop Mirroring**.

## Shortcuts
Open Flick on the laptop (installed app) and on the iPhone → tap **Laptop** on the iPhone.

## Start automatically (optional)
Press Win+R → type `shell:startup` → put a shortcut to **Start Flick Helper.bat** in that folder.

Name it something else: edit the .bat and add `set FLICK_NAME=Moyo's Laptop` before `node helper.js`.
