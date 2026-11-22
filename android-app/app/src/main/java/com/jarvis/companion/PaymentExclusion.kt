package com.jarvis.companion

/**
 * Payment and financial applications are never listed, launched or reported by JARVIS.
 * Mirrors the core exclusion list (src/policy/exclusions.ts); there is no override.
 */
object PaymentExclusion {
    private val terms = Regex(
        "(?:phonepe|paytm|google\\s*pay|gpay|paisa|paypal|wallet|banking|bank|payment|payments)",
        RegexOption.IGNORE_CASE,
    )

    fun isExcluded(label: String, packageName: String): Boolean =
        terms.containsMatchIn(label) || terms.containsMatchIn(packageName)
}
