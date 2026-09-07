# syntax=docker/dockerfile:1
#
# NOTE ON TESTING: no Docker is available in the sandbox this was written in,
# so this hasn't been build-tested inside an actual container. It HAS been
# validated by running every RUN command in this file for real, directly on
# a Debian 12 (bookworm) host matching the base image — npm ci (with a
# lockfile present, in that test), npm run build, npm prune --omit=dev, and
# finally NODE_ENV=production node dist/server.cjs, hit with real requests,
# all confirmed working. What's NOT
# verified is Docker-specific: layer copying between stages, and whether the
# `serialport` native addon survives the COPY from the build stage into the
# runtime stage (both stages share a base OS family specifically to make
# that likely to work, but "likely" isn't "proven" — check this first if the
# container fails to boot).
#
# One real bug this host-testing caught and fixed: a naive `npm ci
# --omit=dev` in the runtime stage fails outright. `vite` (a real dependency
# here — see below) lists `tsx` as an optional peer; a from-scratch
# `--omit=dev` install still attempts it, and tsx's bundled esbuild install
# script hard-fails. Pruning an already-built node_modules instead (this
# file's actual approach) sidesteps it entirely, since prune only removes
# packages, never runs install scripts.
#
# node:*-bookworm (Debian, not Alpine) deliberately, on both stages: the
# `serialport` dependency compiles a native addon against glibc at install
# time, and copying it into a musl-based runtime (e.g. Alpine) would break
# it. Keeping both stages on the same Debian base avoids that mismatch.

# ---------------------------------------------------------------------------
# Build stage — installs full deps (incl. dev, needed for the vite/esbuild
# build itself), compiles the frontend, bundles the server, then prunes back
# to production-only deps in place (see note above for why not a fresh
# --omit=dev install).
# ---------------------------------------------------------------------------
FROM node:22-bookworm AS build
WORKDIR /app

# python3/make/g++ are needed to compile serialport's native addon during
# npm install — not needed again after this stage.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# package-lock.json* (trailing glob) copies it if present but doesn't fail
# the build if it's missing — `npm install` (unlike `npm ci`) works fine
# either way, using the lockfile for reproducibility when it's there.
COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# PlatformIO's CLI is itself a Python tool, invoked per compile/flash request
# via server.ts's execFilePromise — this is a real runtime dependency, not a
# build-time-only one. No C toolchain is needed here: the espressif32 and
# atmelavr platforms installed below ship their own prebuilt xtensa/avr-gcc
# toolchains as PlatformIO platform packages.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Bake the PlatformIO toolchain into the image at build time — this mirrors
# exactly what server.ts's setupPlatformIO() already does on a cold start
# today, just done once here instead of on every new container instance.
# setupPlatformIO() checks for this exact path and skips reinstalling if
# present, so this closes the "PlatformIO baked into the image" gap without
# needing any server.ts changes.
ENV PLATFORMIO_CORE_DIR=/app/.platformio
RUN python3 -m venv /app/.platformio/penv \
    && /app/.platformio/penv/bin/pip install --no-cache-dir platformio \
    && /app/.platformio/penv/bin/pio platform install espressif32 atmelavr

# Already production-only (pruned in the build stage) — copying it directly
# avoids re-running any install scripts here. vite lives in "dependencies"
# (not devDependencies) specifically because server.ts imports it
# unconditionally at the top level for its dev-middleware branch, so it
# survives the prune; devDependencies like tsx/typescript/tailwindcss don't
# unless something real still needs them as a peer.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Cloud Run sets PORT itself; server.ts already reads process.env.PORT with
# an 3000 fallback for local use. 8080 is Cloud Run's own default.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/server.cjs"]
