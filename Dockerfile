FROM node:22-bookworm-slim AS frontend
ENV npm_config_cache=/stow/build/npm-cache
WORKDIR /stow/stow-git
COPY . .
RUN mkdir -p /stow/build/tmp \
    && cp package.json package-lock.json /stow/build/ \
    && npm ci --prefix /stow/build \
    && ln -s build/node_modules /stow/node_modules \
    && /stow/build/node_modules/.bin/tsc --noEmit \
    && /stow/build/node_modules/.bin/vite build

FROM rust:1.94.1-bookworm AS backend
ENV CARGO_HOME=/stow/build/cargo-home CARGO_TARGET_DIR=/stow/build/cargo-target
WORKDIR /stow/stow-git
COPY Cargo.toml Cargo.lock ./
COPY server-rust ./server-rust
RUN cargo build --locked --release --bin stow-server

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends imagemagick curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 1000 --create-home stow \
    && mkdir -p /data /stow/build/tmp /stow/build/cache \
    && chown stow:stow /data /stow/build/tmp /stow/build/cache
ENV HOST=0.0.0.0 PORT=3001 DATA_DIR=/data STOW_STATIC_DIR=/stow/build/dist
ENV TMPDIR=/stow/build/tmp XDG_CACHE_HOME=/stow/build/cache
WORKDIR /stow/stow-git
COPY --from=backend /stow/build/cargo-target/release/stow-server /usr/local/bin/stow-server
COPY --from=frontend /stow/build/dist /stow/build/dist
USER stow
VOLUME /data
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD curl --fail --silent http://127.0.0.1:3001/api/health || exit 1
CMD ["stow-server"]
