# Running Stow with Podman

The repository includes a [Containerfile](../Containerfile) for building the native server and browser assets. These instructions build from source and run Stow behind an existing HTTPS proxy. They do not install that proxy or configure a service to start at boot.

## Build

With Podman installed, run from the source checkout:

```sh
podman build --format oci --tag localhost/stow:local --file Containerfile .
```

The [Podman build reference](https://docs.podman.io/en/latest/markdown/podman-build.1.html) describes OCI images and `.containerignore`. The image contains the Rust executable, built frontend, and image codecs, and runs the server as an unprivileged container user. The run command below configures its health check.

## Configure and run

Create a private `../stow.env` file, outside source and build, with these literal values replaced for your installation:

```dotenv
STOW_AUTH_MODE=password
STOW_PASSWORD=replace-with-a-long-random-password
STOW_ORIGIN=https://notes.example.com
```

Protect it with `chmod 600 ../stow.env`. Podman's env file takes literal `KEY=value` lines; it is not a shell script. The container sets `DATA_DIR=/data` and `STOW_STATIC_DIR=/stow/build/dist` internally.

```sh
podman volume create stow-data
podman run --detach --name stow --restart unless-stopped \
  --env-file ../stow.env \
  --publish 127.0.0.1:3001:3001 \
  --volume stow-data:/data \
  --health-cmd 'curl --fail --silent http://127.0.0.1:3001/api/health' \
  --health-interval 30s --health-timeout 3s --health-start-period 10s \
  localhost/stow:local
```

Use the same host account for subsequent Podman commands. The named volume holds all persistent Stow data; replacing the container does not replace that volume. One server process must own it at a time.

Configure your HTTPS proxy on the same host to forward the selected hostname to `127.0.0.1:3001`, including WebSocket upgrades. Only loopback exposes the application port. Clients must trust the HTTPS certificate. For Caddy, a site block can be:

```caddyfile
notes.example.com {
    reverse_proxy 127.0.0.1:3001
}
```

Caddy can obtain and renew public certificates when DNS and external port access are configured as described in its [automatic HTTPS guide](https://caddyserver.com/docs/automatic-https). Open the configured HTTPS URL and sign in with the Stow password.

## Operation

Use `podman logs stow` for server output and `podman healthcheck run stow` to check readiness. `podman stop stow` and `podman start stow` stop and resume the same container. For a boot-managed service, Podman's [Quadlet integration](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html) creates systemd services from container definitions.

Before an update, stop Stow and [back up its complete data volume and private configuration](../README.md#back-up-and-restore). Rebuild the image, remove only the stopped container with `podman rm stow`, then repeat the run command using the existing `stow-data` volume. Preserve that volume when updating or uninstalling the application.
