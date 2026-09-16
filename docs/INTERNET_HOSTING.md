# Stow behind your HTTPS proxy

Use an existing nginx proxy to serve Stow at a domain such as `stow.example.com`. Stow runs in a Podman container, serves HTTP to nginx, and protects your notes with a Stow password. nginx handles public HTTPS.

## Install Stow

On the computer that will run Stow, use Linux with systemd, Python 3, and Podman 4.9 or later. These commands target Ubuntu 24.04:

```sh
sudo apt update
sudo apt install git podman python3
git clone https://github.com/jonhnet/stow.git stow-git
cd stow-git
sudo ./self-host.py --behind-proxy https://stow.example.com --address 192.168.1.20
```

Replace the domain with your Stow domain and `192.168.1.20` with this computer's fixed private IPv4 address, reachable from nginx. **If nginx runs on this same computer, omit `--address`**; Stow then listens only on `127.0.0.1`.

Choose your Stow password when prompted. The installer builds Stow, saves its data and configuration in `/var/lib/stow`, and starts `stow-app` now and at boot. It prints the HTTP endpoint, normally `http://192.168.1.20:3001`. DNS and HTTPS need not be configured yet. Stow does not claim ports 80 or 443.

## Connect your HTTPS proxy

In your existing DNS and nginx setup:

1. Point `stow.example.com` at your nginx proxy.
2. Add an HTTPS server for that domain with a valid certificate and automatic renewal, using your usual process or [Certbot](https://certbot.eff.org/instructions?ws=nginx&os=snap).
3. On the Stow computer, run `sudo cat /var/lib/stow/nginx-location.conf`. Copy that generated `location / { … }` block into the domain's HTTPS server block, replacing any existing `location /` block. It forwards HTTP and WebSocket sync to Stow and allows image uploads up to 20 MiB.
4. On the nginx computer, run `sudo nginx -t` and then `sudo systemctl reload nginx`.

When nginx is on another machine, allow it to reach Stow's TCP port 3001 over your private network. Keep this HTTP endpoint private; browsers use the HTTPS domain. The installer leaves your DNS, firewall, nginx, and certificates under your control.

Open `https://stow.example.com`, sign in, and optionally choose **Settings → Install Stow**. No certificate import is needed. Let the first sync finish before trying offline use.

## Operate and update

Inspect the service with `sudo systemctl status stow-app` or `sudo journalctl -u stow-app`. After making a backup, update from the checkout:

```sh
git pull --ff-only
sudo ./self-host.py
```

The installer remembers the public URL and HTTP endpoint. Updates retain the password, notes, and server identity; the service keeps running during the build and briefly restarts to activate it. Keep the same public URL so browsers retain access to their existing offline cache.

To change the password, use `sudoedit /var/lib/stow/stow.env`, change only `STOW_PASSWORD`, then run `sudo systemctl restart stow-app`. Devices will need to sign in again.

## Back up and restore

From the checkout:

```sh
sudo systemctl stop stow-app
sudo sh -c 'umask 077; tar -C /var/lib -czf ../stow-backup.tgz stow'
sudo systemctl start stow-app
```

Protect this backup: it contains your notes, password, settings, and server identity. Keep dated copies on another device. Back up nginx's configuration and certificates through your existing proxy backup process. Only edits and images already synchronized to the server are included; see the [backup semantics](../README.md#back-up-and-restore).

To restore, stop `stow-app` and preserve the existing `/var/lib/stow` separately. Restore the complete backup under `/var/lib`, retaining ownership and permissions, then rerun `sudo ./self-host.py` from a checkout. It recreates the service using the restored settings. If moving to a different private address, supply `--address NEW_PRIVATE_IP` and update nginx with the newly generated snippet; keep the public URL unchanged.

## Setup options

`--port` changes the HTTP port. `--name` and `--state-dir` select a separate service instance and data directory; keep supplying those two options on updates and adjust the operation commands above accordingly. For example, to try this alongside an existing home installation, add `--name stow-public --state-dir /var/lib/stow-public` to the install command. The installer will not convert an existing home vault to a different browser URL.

For unattended installs, `--password-file` reads the initial password from a private file. `--build-network host` is available when Podman's default build network is unavailable; it affects image builds only.
