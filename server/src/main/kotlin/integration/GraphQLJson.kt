package ch.nokillswit.integration

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.encodeToJsonElement

/** The GraphQL-over-HTTP POST body (query required; operationName/variables optional). */
@Serializable
data class GraphQLHttpRequest(
    val query: String,
    val operationName: String? = null,
    val variables: JsonObject? = null,
)

/**
 * DTO → the Map tree graphql-java's PropertyDataFetcher reads. THE mechanical reason this
 * exists: Kotlin name-mangles the getters of UInt-typed properties (inline value class), so
 * reflection over the shared response DTOs would silently yield nulls for every id — routing
 * through kotlinx-serialization instead reuses the exact REST wire names and turns UInt into
 * plain numbers. Enums become their names (GraphQL enum output coercion accepts them).
 */
inline fun <reified T> T.toGraphQL(): Map<String, Any?> {
    val element = graphQlJson.encodeToJsonElement(this)
    // Safe: every DTO this is called on encodes to a JsonObject, so toAnyValue() always
    // returns a Map here — the cast just recovers the static type erased by the JsonElement dispatch.
    @Suppress("UNCHECKED_CAST")
    return element.toAnyValue() as Map<String, Any?>
}

/** encodeDefaults = true so a DTO property with a Kotlin default (the TeamKpiResponse.canManage
 *  class) still lands in the map — the bare Json companion would silently drop the key, turning
 *  a future non-null SDL field into a runtime null error (checkup #30, A-L6). */
@PublishedApi
internal val graphQlJson: Json = Json { encodeDefaults = true }

/** JsonElement → plain Kotlin values (maps/lists/Long/Double/Boolean/String/null). Integral
 *  numbers become Long — graphql-java's Int coercion accepts any in-range Number, and the
 *  custom Long scalar needs the full width. */
fun JsonElement.toAnyValue(): Any? = when (this) {
    is JsonNull -> null
    is JsonPrimitive -> when {
        isString -> content
        content == "true" -> true
        content == "false" -> false
        // The lenient default Json accepts unquoted tokens as non-string primitives — fall
        // back to the raw content instead of a NumberFormatException that would escape the
        // transport as a 500 (checkup #30, A-M3).
        else -> content.toLongOrNull() ?: content.toDoubleOrNull() ?: content
    }
    is JsonArray -> map { it.toAnyValue() }
    is JsonObject -> mapValues { (_, v) -> v.toAnyValue() }
}

/** Plain values (a GraphQL response specification tree) → JsonElement for ContentNegotiation. */
fun Any?.toJsonElement(): JsonElement = when (this) {
    null -> JsonNull
    is String -> JsonPrimitive(this)
    is Boolean -> JsonPrimitive(this)
    is Number -> JsonPrimitive(this)
    is Map<*, *> -> JsonObject(entries.associate { (k, v) -> k.toString() to v.toJsonElement() })
    is Iterable<*> -> JsonArray(map { it.toJsonElement() })
    else -> JsonPrimitive(toString())
}
