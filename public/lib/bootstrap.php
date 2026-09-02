<?php
/**
 * Shared helpers and configuration. Every lib file is included from api.php;
 * none of them are meant to be requested directly.
 */

declare(strict_types=1);

if (!defined('PODCAST_APP')) {
    http_response_code(404);
    exit;
}

const USER_AGENT      = 'PodcastsWeb/1.0 (+https://podcast.4thepeople.live)';
const FETCH_TIMEOUT   = 20;
const MAX_FEED_BYTES  = 12582912;        // 12 MB
const MAX_AUDIO_BYTES = 419430400;       // 400 MB
const MAX_REDIRECTS   = 5;
const FEED_CACHE_TTL  = 300;

const TOKEN_TTL       = 60 * 60 * 24 * 90;   // 90 days
const MAX_LOGIN_FAILS = 8;
const LOCKOUT_SECONDS = 900;

/**
 * Who may create an account:
 *   'invite' - needs the code in data/invite-code.txt (default)
 *   'open'   - anyone
 *   'closed' - nobody; you create accounts yourself
 */
const REGISTRATION = 'invite';

function json_out($payload, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($payload);
    exit;
}

function fail(int $status, string $message): void
{
    json_out(array('error' => $message), $status);
}

function send_body(string $body, string $contentType, string $cache): void
{
    header('Content-Type: ' . $contentType);
    header('Cache-Control: ' . $cache);
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: no-referrer');
    header('Content-Length: ' . strlen($body));
    echo $body;
    exit;
}

/** Request body as an array, for JSON POSTs. */
function json_input(): array
{
    // Cached: the router validates the body and the handler then reads it
    // again, and php://input is not reliably re-readable on every SAPI.
    static $cached = null;
    if ($cached !== null) {
        return $cached;
    }
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        $cached = array();
        return $cached;
    }
    $decoded = json_decode($raw, true);
    $cached = is_array($decoded) ? $decoded : array();
    return $cached;
}

function field(array $source, string $key, string $default = ''): string
{
    return isset($source[$key]) && is_scalar($source[$key])
        ? trim((string) $source[$key])
        : $default;
}

function clamp_int($raw, int $low, int $high, int $fallback): int
{
    if (is_int($raw)) {
        return max($low, min($high, $raw));
    }
    if (!is_string($raw) || !ctype_digit($raw)) {
        return $fallback;
    }
    return max($low, min($high, (int) $raw));
}

/**
 * Writable storage for the database and feed cache.
 *
 * Preferred location is above the document root, so the SQLite file is not
 * reachable over HTTP even if .htaccess is ignored (some hosts run nginx).
 * Falls back to ./data, which ships with a deny-all .htaccess.
 */
function data_dir(): ?string
{
    static $resolved = false;
    static $path = null;

    if ($resolved) {
        return $path;
    }
    $resolved = true;

    $root = isset($_SERVER['DOCUMENT_ROOT']) ? rtrim($_SERVER['DOCUMENT_ROOT'], '/') : '';
    $candidates = array();
    if ($root !== '') {
        $candidates[] = dirname($root) . '/podcast-data';
    }
    $candidates[] = __DIR__ . '/../data';

    foreach ($candidates as $candidate) {
        if (!is_dir($candidate)) {
            @mkdir($candidate, 0700, true);
        }
        if (is_dir($candidate) && is_writable($candidate)) {
            $path = $candidate;
            return $path;
        }
    }
    return null;
}

function data_dir_is_public(): bool
{
    $dir = data_dir();
    $root = isset($_SERVER['DOCUMENT_ROOT']) ? rtrim($_SERVER['DOCUMENT_ROOT'], '/') : '';
    if ($dir === null || $root === '') {
        return false;
    }
    return strpos(realpath($dir) ?: $dir, realpath($root) ?: $root) === 0;
}

function now(): int
{
    return time();
}
