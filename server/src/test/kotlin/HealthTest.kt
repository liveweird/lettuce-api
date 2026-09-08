package ch.nokillswit

import ch.nokillswit.settings.AppSettingsService
import ch.nokillswit.settings.AppSettingsServiceKey
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase

/**
 * The Kubernetes health endpoints (plugins/Health.kt). Both are unauthenticated and outside
 * `/api/`, so the OpenApiConformance plugin skips them and `jsonClient()` is fine. Tests run in
 * development mode, so there is no HTTPS redirect to satisfy.
 */
class HealthTest {

    @Test
    fun `healthz reports liveness`() = testApplication {
        usePostgresTestcontainer()
        val response = jsonClient().get("/healthz")
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals("OK", response.bodyAsText())
    }

    @Test
    fun `readyz reports ready when the database answers`() = testApplication {
        usePostgresTestcontainer()
        val response = jsonClient().get("/readyz")
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals("OK", response.bodyAsText())
    }

    @Test
    fun `readyz reports not-ready (503) when the database round-trip fails`() = testApplication {
        configureApp()
        // An extra module added here runs AFTER the yaml-configured ones (`ktor.application.modules`
        // — including configureDatabase, which publishes AppSettingsServiceKey — load before any
        // module added via TestApplicationBuilder.application{}), so this overwrites the published
        // service with one pointed at an unreachable database: a deterministic, fast failure for
        // /readyz's round-trip, with no real outage or connection-breaking needed.
        application {
            val brokenDatabase = R2dbcDatabase.connect(
                url = "r2dbc:postgresql://localhost:1/nonexistent",
                user = "nobody",
                password = "nobody",
            )
            attributes.put(AppSettingsServiceKey, AppSettingsService(brokenDatabase))
        }
        startApplication()

        val response = jsonClient().get("/readyz")
        assertEquals(HttpStatusCode.ServiceUnavailable, response.status)
    }
}
