/**
 * Post-processing logic for transcription results
 * Applies regex-based rules based on user configuration
 */

import {
    isCollapseWhitespaceEnabled,
    isCollapseRepeatedWordsEnabled,
    isPunctuationSpacingEnabled,
    isCapitalizeFirstEnabled,
} from "./config";

/**
 * Process the transcription text according to enabled rules
 * Order of operations:
 * 1. Collapse Whitespace
 * 2. Collapse Repeated Words
 * 3. Punctuation Spacing
 * 4. Capitalize First
 */
export function processTranscription(text: string): string {
    if (!text) return text;

    let processed = text;

    // 1. Collapse Whitespace: Reduces multiple spaces to a single space
    // Also handles other whitespace characters nicely by replacing them with a single space
    if (isCollapseWhitespaceEnabled()) {
        processed = processed.replace(/\s+/g, " ");
    }

    // 2. Collapse Repeated Words: Merges adjacent identical words (case-insensitive)
    // e.g. "is is" -> "is", "The The" -> "The"
    // Keeps the casing of the first occurrence
    if (isCollapseRepeatedWordsEnabled()) {
        processed = processed.replace(/\b(\w+)\s+\1\b/gi, "$1");
    }

    // 3. Punctuation Spacing: Ensures a space after punctuation if missing
    // Looks for , . ! ? followed immediately by a non-whitespace character
    if (isPunctuationSpacingEnabled()) {
        processed = processed.replace(/([,.!?])(?=[^\s])/g, "$1 ");
    }

    // 4. Capitalize First: Capitalizes the first character of the string
    if (isCapitalizeFirstEnabled()) {
        if (processed.length > 0) {
            processed = processed.charAt(0).toUpperCase() + processed.slice(1);
        }
    }

    return processed;
}
