# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32

# ── Stage 1: build the React SPA ──────────────────────────────────────────────
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS web
RUN apk add --no-cache git
WORKDIR /web
# Install deps first for layer caching. --legacy-peer-deps per web/ README
# (openapi-typescript declares TS ^5 while the scaffold uses TS 6).
COPY web/package.json web/package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY web/ ./
# .git is copied last so a new commit only busts the build layer, and the version
# stamp is computed explicitly here: the vite config's `git status` dirty check
# would always be a false positive in this stage (the worktree is just web/).
COPY .git .git
# schema.ts is committed, so `vite build` needs no running server / gen:api.
RUN GIT_SHA=$(git rev-parse --short HEAD) \
    && GIT_COMMIT_TIME=$(git log -1 --format=%cI) \
    && export GIT_SHA GIT_COMMIT_TIME \
    && npm run build

# ── Stage 2: build the server distribution ────────────────────────────────────
FROM eclipse-temurin:21-jdk@sha256:85f00967bcc624fc19fa9c2cf124ea426a5363898e267141726f31f358c2e14b AS server
WORKDIR /src
# Copy build scripts + wrapper first so the Gradle distribution download caches.
COPY gradlew settings.gradle.kts build.gradle.kts gradle.properties gradle.lockfile settings-gradle.lockfile ./
COPY gradle/ gradle/
RUN ./gradlew --version --no-daemon
# Module build files, then sources.
COPY core/build.gradle.kts core/gradle.lockfile core/
COPY server/build.gradle.kts server/gradle.lockfile server/
COPY core/src/ core/src/
COPY server/src/ server/src/
# installDist keeps every dependency as its own JAR, so Flyway's ServiceLoader
# plugin discovery works exactly as under `:server:run` (a fat JAR collapses the
# duplicate META-INF/services descriptors and breaks Flyway at startup).
RUN ./gradlew :server:installDist --no-daemon

# ── Stage 3: runtime ──────────────────────────────────────────────────────────
# JRE 21 matches the build stage (21-jdk) and the Gradle toolchain (jvmToolchain(21)) — the app
# ships on the same LTS JVM the test suite runs against. Bump all three together if you move to a
# newer JVM, so tests exercise the runtime you deploy.
FROM eclipse-temurin:21-jre@sha256:7a65df4b22d2de92d4e04056e884f3b9122d70b21e2847fd66084278bd0ce037 AS runtime
WORKDIR /app
COPY --from=server /src/server/build/install/server/ ./
COPY --from=web /web/dist web
# Run as a fixed, unprivileged uid/gid (Checkup #34 Tier A pod hardening — pairs with the
# k8s manifest's runAsNonRoot/readOnlyRootFilesystem, which needs a real numeric uid to
# check against). No entry in /etc/passwd is required — the app never shells out or looks
# itself up by name. WORKDIR is chown'd before the switch since --chown on COPY --from
# would need repeating on every copy above; a single chown after is simpler here.
RUN chown -R 1000:1000 /app
USER 1000:1000
ENV WEB_STATIC_DIR=/app/web
# The shipped image runs in production mode: the JWT-secret and seed-password fail-closed
# checks are active, and HSTS + HTTPS redirect are on. Local demos (docker-compose.yaml)
# explicitly override this back to true.
ENV KTOR_DEVELOPMENT=false
# No outbound email by default: the password-reset endpoint answers 503 until the
# deployment sets MAIL_TRANSPORT=smtp with real SMTP_* settings (production mode
# refuses the passwords-into-logs `log` transport).
ENV MAIL_TRANSPORT=disabled
EXPOSE 8080
ENTRYPOINT ["/app/bin/server"]
