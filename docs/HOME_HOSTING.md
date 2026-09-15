# Stow on your home network

This setup runs Stow and Caddy as Podman containers managed by systemd. It serves one password-protected vault at a fixed LAN address, with HTTPS from a local certificate authority. You need no domain name, router port forwarding, or cloud account. Installation and updates download software; normal use stays on your home network.

## Install

Use an always-on Linux computer with systemd, Python 3, and Podman 4.9 or later. The commands below target Ubuntu 24.04. The installer needs `sudo` to create system services; the Stow process inside its container runs as an unprivileged user. Node.js and Rust are included in the container build and need not be installed on the host.

```sh
sudo apt update
sudo apt install git podman python3
git clone https://github.com/jonhnet/stow.git stow-git
cd stow-git
sudo ./self-host.py --address 192.168.1.20
```

Replace `192.168.1.20` with this computer's LAN IPv4 address. First reserve that address for the computer in your router's DHCP settings, so it stays the same after a restart. The installer prompts for your Stow password, builds the application, starts HTTPS, and prints its URL and public CA certificate location. Services start automatically at boot.

The default URL is `https://192.168.1.20:8443`. Only TCP port 8443 on the selected address is published; the application's HTTP port is internal. If a host firewall is enabled, allow that port from your home subnet. For example, with UFW and a `192.168.1.0/24` home network:

```sh
sudo ufw allow from 192.168.1.0/24 to 192.168.1.20 port 8443 proto tcp
```

Use your actual subnet and server address. Devices must be on a network that permits connections to the server; guest Wi-Fi may isolate them. The installer does not change the firewall or router.

## Trust the certificate on each device

Browsers require trusted HTTPS for offline startup and Stow's security APIs. Caddy issues and renews the server certificate using a local CA; keeping that CA lets the devices continue trusting the server across updates. [Caddy local HTTPS](https://caddyserver.com/docs/automatic-https#local-https)

Export the **public** certificate to a file beside your checkout:

```sh
sudo cat /var/lib/stow/stow-ca.crt > ../stow-ca.crt
```

Transfer `stow-ca.crt` to each phone or computer using a file-transfer method you already trust. The installer prints its SHA-256 fingerprint for checking the certificate. Keep the rest of `/var/lib/stow/tls` private: it contains the CA's signing keys.

On Android, open Settings and search for **Install a certificate**. Choose **CA certificate**, acknowledge Android's warning, and select `stow-ca.crt`. The setting is usually under **Security & privacy → More security settings → Encryption & credentials**; menu names vary by device. Choose the CA option rather than the Wi-Fi or VPN/app certificate options.

On a computer, import `stow-ca.crt` as a trusted certificate authority in the browser or operating system's certificate settings. Chrome uses local trust settings; Firefox can use its own Authorities list. [Chrome local certificate trust](https://chromium.googlesource.com/chromium/src/+/main/net/data/ssl/chrome_root_store/faq.md)

Then open the printed **HTTPS** URL in Chrome and sign in. There should be no certificate warning. In Stow, choose **Settings → Install Stow** when offered, or use Chrome's install menu. Let the first sync finish before testing offline use. Away from home, cached notes remain editable and sync when you return.

## Operate and update

From any directory:

```sh
sudo systemctl status stow-app stow-https
sudo journalctl -u stow-app -u stow-https
```

After making a backup, update from the checkout:

```sh
git pull --ff-only
sudo ./self-host.py
```

The existing service stays up while the new image builds. Activation briefly restarts it. A failed activation restores the previous service definitions. The password, notes, server identity, and local CA are retained. To change the password, use `sudoedit /var/lib/stow/stow.env`, change only `STOW_PASSWORD`, then run `sudo systemctl restart stow-app`; devices will need to sign in again.

Keep the same IP address and port. Changing the URL gives browsers a different local cache, including a different home for pending offline edits; the installer rejects an accidental origin change.

## Back up and restore

The complete `/var/lib/stow` directory contains notes and images, server identity, password configuration, and the local CA. Keep it outside the checkout and disposable build caches. A CA backup prevents having to reinstall trust on every device.

From the checkout, stop both services before copying the directory:

```sh
sudo systemctl stop stow-https stow-app
sudo sh -c 'umask 077; tar -C /var/lib -czf ../stow-home-backup.tgz stow'
sudo systemctl start stow-https
```

Starting HTTPS also starts its application dependency. Protect this backup: it includes your password and CA private keys. Move it to a separate device, and keep multiple dated copies. Only edits and images already synchronized to the server are included; see the [backup semantics](../README.md#back-up-and-restore).

To restore, stop both services and preserve the existing `/var/lib/stow` separately. Restore the complete backup under `/var/lib`, retaining its ownership and permissions, then rerun `sudo ./self-host.py` from a checkout. It recreates service definitions and keeps the restored password, identity, and CA. The server must have the same reserved address for the existing device URL to work.

## Setup options

`--port` selects a different unprivileged HTTPS port on the first install. `--name` and `--state-dir` allow a separate service instance and state directory; keep supplying those two options on updates, and adjust the operation commands above to match. `--password-file` reads the initial password from a private file for unattended setup; its value is never passed on a command line.

`--build-network host` explicitly selects host networking for image builds when Podman's default build network is unavailable. Runtime containers still use their dedicated bridge network.
