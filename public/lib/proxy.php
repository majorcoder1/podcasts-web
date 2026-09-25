<?php
/**
 * Feed and directory proxy.
 *
 * Podcast feeds send no CORS headers, so the browser cannot fetch them
 * directly. These routes are the only reason this app needs a server for
 * playback at all.
 */

declare(strict_types=1);

if (!defined('PODCAST_APP')) {
    http_response_code(404);
    exit;
}

const ITUNES_SEARCH = 'https://itunes.apple.com/search';
const ITUNES_CHARTS = 'https://itunes.apple.com/us/rss/toppodcasts';

/**
 * Requests allowed per visitor IP in each window, as [guest, signed in].
 * Generous for a person using the app; far too few to use this server as a
 * free download mirror.
 */
const PROXY_LIMITS = array(
    'feed'   => array(300, 1200),   // per 10 minutes
    'search' => array(120, 600),
    'charts' => array(120, 600),
    'audio'  => array(30, 200),     // per hour: each one can be a whole episode
);
const PROXY_WINDOWS = array('feed' => 600, 'search' => 600, 'charts' => 600, 'audio' => 3600);

/**
 * Keeps the proxy for this site's own pages.
 *
 * Browsers label every request with Sec-Fetch-Site, and a page on another
 * site cannot fake it, so hotlinking and embedding are refused outright.
 * A script outside a browser can fake anything, which is what the per-IP
 * limit below is for.
 */
function guard_proxy(string $route): void
{
    $site = isset($_SERVER['HTTP_SEC_FETCH_SITE']) ? strtolower($_SERVER['HTTP_SEC_FETCH_SITE']) : '';
    if ($site !== '' && $site !== 'same-origin' && $site !== 'none') {
        fail(403, 'This proxy only serves this site');
    }

    // Only touch the database when there is a session to check.
    $signedIn = presented_token() !== '' && current_user() !== null;
    $limit  = PROXY_LIMITS[$route][$signedIn ? 1 : 0];
    $window = PROXY_WINDOWS[$route];
    if (!rate_limit_take($route, $limit, $window)) {
        header('Retry-After: ' . $window);
        fail(429, 'Too many requests. Wait a few minutes and try again.');
    }
}

/**
 * Fixed-window counter per IP and route, kept as small files in the data
 * directory so it needs no database. Returns false once the window is spent.
 * If there is nowhere to write, it lets the request through rather than
 * breaking the app.
 */
function rate_limit_take(string $bucket, int $limit, int $window): bool
{
    $dir = data_dir();
    if ($dir === null) {
        return true;
    }
    $store = $dir . '/rate-limit';
    if (!is_dir($store) && !@mkdir($store, 0700, true) && !is_dir($store)) {
        return true;
    }

    $ip   = isset($_SERVER['REMOTE_ADDR']) ? (string) $_SERVER['REMOTE_ADDR'] : 'unknown';
    $slot = intdiv(time(), $window);
    $path = $store . '/' . sha1($bucket . '|' . $ip) . '.txt';

    $file = @fopen($path, 'c+');
    if ($file === false) {
        return true;
    }
    flock($file, LOCK_EX);
    $raw = stream_get_contents($file);
    list($savedSlot, $count) = array_map('intval', explode(':', $raw !== false && $raw !== '' ? $raw : '0:0') + array(0, 0));
    if ($savedSlot !== $slot) {
        $count = 0;
    }
    $count++;
    ftruncate($file, 0);
    rewind($file);
    fwrite($file, $slot . ':' . $count);
    flock($file, LOCK_UN);
    fclose($file);

    // Now and then, sweep counters nobody has touched for a day.
    if (mt_rand(1, 500) === 1) {
        foreach (glob($store . '/*.txt') ?: array() as $old) {
            if (filemtime($old) < time() - 86400) {
                @unlink($old);
            }
        }
    }
    return $count <= $limit;
}

/**
 * Reject anything that is not a plain public http(s) URL.
 *
 * This script can reach the host's own network, so an unguarded ?url= would let
 * any visitor probe localhost and whatever sits behind it. Every redirect hop
 * is re-checked by the fetchers for the same reason.
 *
 * Returns the parsed URL plus 'pin', the checked address the connection must
 * use. Without the pin, cURL would look the name up a second time, and a
 * hostile DNS server can answer that second lookup with 127.0.0.1.
 */
function assert_public_url(string $raw): array
{
    $parts = parse_url($raw);
    if ($parts === false || empty($parts['scheme']) || empty($parts['host'])) {
        fail(400, 'That is not a valid URL');
    }
    $scheme = strtolower($parts['scheme']);
    if ($scheme !== 'http' && $scheme !== 'https') {
        fail(400, 'Only http and https URLs are allowed');
    }
    if (isset($parts['user']) || isset($parts['pass'])) {
        fail(400, 'URLs with credentials are not allowed');
    }

    $host = trim($parts['host'], '[]');
    $addresses = array();

    if (filter_var($host, FILTER_VALIDATE_IP)) {
        $addresses[] = $host;
    } else {
        $v4 = gethostbynamel($host);
        if (is_array($v4)) {
            $addresses = $v4;
        }
        $v6 = @dns_get_record($host, DNS_AAAA);
        if (is_array($v6)) {
            foreach ($v6 as $record) {
                if (!empty($record['ipv6'])) {
                    $addresses[] = $record['ipv6'];
                }
            }
        }
        if (!$addresses) {
            fail(502, 'Could not resolve host');
        }
    }

    foreach ($addresses as $address) {
        if (!is_public_ip($address)) {
            fail(403, 'That host is not publicly routable');
        }
    }

    $parts['scheme'] = $scheme;
    $parts['host']   = $host;
    $parts['port']   = isset($parts['port']) ? (int) $parts['port'] : ($scheme === 'https' ? 443 : 80);
    $parts['pin']    = $addresses[0];
    return $parts;
}

function is_public_ip(string $address): bool
{
    $flags = FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE;
    if (filter_var($address, FILTER_VALIDATE_IP, $flags) === false) {
        return false;
    }
    // An IPv6 address can carry an IPv4 one inside it (::ffff:127.0.0.1,
    // 64:ff9b::7f00:1). Unwrap it and check the IPv4 part as well.
    if (strpos($address, ':') !== false) {
        $packed = @inet_pton($address);
        if ($packed === false) {
            return false;
        }
        $prefix = substr($packed, 0, 12);
        if ($prefix === str_repeat("\0", 10) . "\xff\xff"
            || $prefix === "\x00\x64\xff\x9b" . str_repeat("\0", 8)
            || $prefix === str_repeat("\0", 12)) {
            $inner = inet_ntop(substr($packed, 12));
            return filter_var($inner, FILTER_VALIDATE_IP, $flags) !== false;
        }
    }
    return true;
}

/** "host:port:address" for CURLOPT_RESOLVE; IPv6 addresses go in brackets. */
function curl_pin(array $target): array
{
    $address = strpos($target['pin'], ':') !== false ? '[' . $target['pin'] . ']' : $target['pin'];
    return array($target['host'] . ':' . $target['port'] . ':' . $address);
}

/**
 * The same URL with the host swapped for the pinned address, plus the stream
 * context options that keep the Host header and TLS name checks on the real
 * name. Used only when the host has no cURL.
 */
function stream_pin(array $target, string $url): array
{
    $address = strpos($target['pin'], ':') !== false ? '[' . $target['pin'] . ']' : $target['pin'];
    $pinned  = $target['scheme'] . '://' . $address . ':' . $target['port']
        . (isset($target['path']) ? $target['path'] : '/')
        . (isset($target['query']) ? '?' . $target['query'] : '');
    $hostHeader = $target['host'];
    if (($target['scheme'] === 'https' && $target['port'] !== 443)
        || ($target['scheme'] === 'http' && $target['port'] !== 80)) {
        $hostHeader .= ':' . $target['port'];
    }
    return array($pinned, $hostHeader, array(
        'peer_name'         => $target['host'],
        'verify_peer'       => true,
        'verify_peer_name'  => true,
    ));
}

/**
 * Fetch a validated URL into memory. Redirects are followed by hand so each
 * hop is re-validated; cURL's own follower would skip that check entirely.
 * Only for feeds and directory JSON - audio is streamed by stream_audio().
 *
 * @return array{body:string,type:string}
 */
function fetch_url(string $url, string $accept, int $limit): array
{
    $hops = 0;

    while (true) {
        $target = assert_public_url($url);

        $result = function_exists('curl_init')
            ? fetch_with_curl($url, $target, $accept, $limit)
            : fetch_with_streams($url, $target, $accept, $limit);

        if ($result['redirect'] !== null) {
            if (++$hops > MAX_REDIRECTS) {
                fail(502, 'Too many redirects');
            }
            $url = resolve_redirect($url, $result['redirect']);
            continue;
        }

        if ($result['status'] >= 400) {
            fail(502, 'Upstream returned ' . $result['status']);
        }
        if (strlen($result['body']) > $limit) {
            fail(502, 'Upstream response too large');
        }
        return array('body' => $result['body'], 'type' => $result['type']);
    }
}

function fetch_with_curl(string $url, array $target, string $accept, int $limit): array
{
    $handle = curl_init($url);
    curl_setopt_array($handle, array(
        CURLOPT_RETURNTRANSFER   => true,
        CURLOPT_FOLLOWLOCATION   => false,
        CURLOPT_PROTOCOLS        => CURLPROTO_HTTP | CURLPROTO_HTTPS,
        CURLOPT_RESOLVE          => curl_pin($target),
        CURLOPT_HEADER           => false,
        CURLOPT_CONNECTTIMEOUT   => 10,
        CURLOPT_TIMEOUT          => FETCH_TIMEOUT,
        CURLOPT_ENCODING         => '',
        CURLOPT_USERAGENT        => USER_AGENT,
        CURLOPT_HTTPHEADER       => array('Accept: ' . $accept),
        CURLOPT_NOPROGRESS       => false,
        CURLOPT_PROGRESSFUNCTION => function ($resource, $downloaded) use ($limit) {
            return $downloaded > $limit ? 1 : 0;   // non-zero aborts the transfer
        },
    ));

    $body   = curl_exec($handle);
    $status = (int) curl_getinfo($handle, CURLINFO_HTTP_CODE);
    $type   = (string) curl_getinfo($handle, CURLINFO_CONTENT_TYPE);
    $location = (string) curl_getinfo($handle, CURLINFO_REDIRECT_URL);
    $error  = curl_error($handle);
    curl_close($handle);

    if ($body === false && $error !== '') {
        fail(504, 'Upstream did not respond');
    }
    if ($status >= 300 && $status < 400 && $location !== '') {
        return array('redirect' => $location, 'status' => $status, 'body' => '', 'type' => '');
    }
    return array(
        'redirect' => null,
        'status'   => $status,
        'body'     => $body === false ? '' : $body,
        'type'     => $type !== '' ? $type : 'application/octet-stream',
    );
}

/** Opens a pinned stream; returns [resource, status, type, redirect, length]. */
function open_stream(string $url, array $target, string $accept, int $timeout): array
{
    if (!ini_get('allow_url_fopen')) {
        fail(500, 'This host has neither cURL nor allow_url_fopen enabled');
    }

    list($pinned, $hostHeader, $ssl) = stream_pin($target, $url);
    $context = stream_context_create(array(
        'http' => array(
            'method'          => 'GET',
            'header'          => 'Host: ' . $hostHeader . "\r\nUser-Agent: " . USER_AGENT
                . "\r\nAccept: " . $accept . "\r\n",
            'timeout'         => $timeout,
            'follow_location' => 0,
            'ignore_errors'   => true,
        ),
        'ssl' => $ssl,
    ));

    $stream = @fopen($pinned, 'rb', false, $context);
    if ($stream === false) {
        fail(504, 'Upstream did not respond');
    }

    $meta     = stream_get_meta_data($stream);
    $status   = 200;
    $type     = 'application/octet-stream';
    $redirect = null;
    $length   = null;
    foreach ($meta['wrapper_data'] as $line) {
        if (preg_match('#^HTTP/[\d.]+\s+(\d{3})#i', $line, $match)) {
            $status = (int) $match[1];
        } elseif (stripos($line, 'Location:') === 0) {
            $redirect = trim(substr($line, 9));
        } elseif (stripos($line, 'Content-Type:') === 0) {
            $type = trim(substr($line, 13));
        } elseif (stripos($line, 'Content-Length:') === 0) {
            $length = trim(substr($line, 15));
        }
    }
    if (!($status >= 300 && $status < 400)) {
        $redirect = null;
    }
    return array($stream, $status, $type, $redirect, $length);
}

function fetch_with_streams(string $url, array $target, string $accept, int $limit): array
{
    list($stream, $status, $type, $redirect) = open_stream($url, $target, $accept, FETCH_TIMEOUT);
    if ($redirect !== null) {
        fclose($stream);
        return array('redirect' => $redirect, 'status' => $status, 'body' => '', 'type' => '');
    }
    $body = @stream_get_contents($stream, $limit + 1);
    fclose($stream);
    return array(
        'redirect' => null,
        'status'   => $status,
        'body'     => $body === false ? '' : $body,
        'type'     => $type,
    );
}

function is_audio_type(string $type): bool
{
    $type = strtolower($type);
    return strpos($type, 'audio/') === 0
        || strpos($type, 'video/') === 0
        || strpos($type, 'application/octet-stream') === 0;
}

/** Headers for an audio response, sent once the upstream has been checked. */
function start_audio_response(string $type, ?string $length): void
{
    @set_time_limit(0);
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    header('Content-Type: ' . $type);
    header('Cache-Control: public, max-age=86400');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: no-referrer');
    if ($length !== null && ctype_digit($length)) {
        header('Content-Length: ' . $length);
    }
}

/**
 * Pass an audio file through in small chunks instead of holding it in memory.
 * A 400 MB episode used to sit whole in PHP's memory, so a handful of
 * downloads at once could take the site down.
 */
function stream_audio(string $url): void
{
    $hops = 0;

    while (true) {
        $target = assert_public_url($url);

        if (function_exists('curl_init')) {
            $redirect = stream_audio_curl($url, $target);
        } else {
            $redirect = stream_audio_streams($url, $target);
        }
        if ($redirect === null) {
            exit;
        }
        if (++$hops > MAX_REDIRECTS) {
            fail(502, 'Too many redirects');
        }
        $url = resolve_redirect($url, $redirect);
    }
}

/** Streams the body and exits, or returns the redirect target. */
function stream_audio_curl(string $url, array $target): ?string
{
    $state = array('status' => 0, 'type' => '', 'length' => null, 'location' => null,
                   'started' => false, 'sent' => 0, 'error' => null);

    $handle = curl_init($url);
    curl_setopt_array($handle, array(
        CURLOPT_FOLLOWLOCATION  => false,
        CURLOPT_PROTOCOLS       => CURLPROTO_HTTP | CURLPROTO_HTTPS,
        CURLOPT_RESOLVE         => curl_pin($target),
        CURLOPT_CONNECTTIMEOUT  => 10,
        // A long episode legitimately takes minutes; give up only on a stall.
        CURLOPT_LOW_SPEED_LIMIT => 1024,
        CURLOPT_LOW_SPEED_TIME  => 30,
        CURLOPT_USERAGENT       => USER_AGENT,
        CURLOPT_HTTPHEADER      => array('Accept: audio/*'),
        CURLOPT_HEADERFUNCTION  => function ($resource, $line) use (&$state) {
            if (preg_match('#^HTTP/[\d.]+\s+(\d{3})#i', $line, $match)) {
                // A new status line starts a new header block (e.g. after 100 Continue).
                $state['status'] = (int) $match[1];
                $state['type'] = '';
                $state['length'] = null;
                $state['location'] = null;
            } elseif (stripos($line, 'Location:') === 0) {
                $state['location'] = trim(substr($line, 9));
            } elseif (stripos($line, 'Content-Type:') === 0) {
                $state['type'] = trim(substr($line, 13));
            } elseif (stripos($line, 'Content-Length:') === 0) {
                $state['length'] = trim(substr($line, 15));
            }
            return strlen($line);
        },
        CURLOPT_WRITEFUNCTION   => function ($resource, $chunk) use (&$state) {
            if (!$state['started']) {
                if ($state['status'] >= 300 && $state['status'] < 400) {
                    return strlen($chunk);   // a redirect's own body; ignore it
                }
                if ($state['status'] >= 400) {
                    $state['error'] = array(502, 'Upstream returned ' . $state['status']);
                    return 0;
                }
                $type = $state['type'] !== '' ? $state['type'] : 'application/octet-stream';
                if (!is_audio_type($type)) {
                    $state['error'] = array(415, 'That URL is not audio');
                    return 0;
                }
                if ($state['length'] !== null && ctype_digit($state['length'])
                    && (int) $state['length'] > MAX_AUDIO_BYTES) {
                    $state['error'] = array(502, 'Upstream response too large');
                    return 0;
                }
                start_audio_response($type, $state['length']);
                $state['started'] = true;
            }
            $state['sent'] += strlen($chunk);
            if ($state['sent'] > MAX_AUDIO_BYTES) {
                return 0;
            }
            echo $chunk;
            flush();
            return strlen($chunk);
        },
    ));

    $ok = curl_exec($handle);
    curl_close($handle);

    if ($state['started']) {
        exit;   // headers are out; a failure part-way can only end the response
    }
    if ($state['error'] !== null) {
        fail($state['error'][0], $state['error'][1]);
    }
    if ($state['status'] >= 300 && $state['status'] < 400 && $state['location'] !== null) {
        return $state['location'];
    }
    if ($ok === false || $state['status'] === 0) {
        fail(504, 'Upstream did not respond');
    }
    if ($state['status'] >= 400) {
        fail(502, 'Upstream returned ' . $state['status']);
    }
    // A successful response with an empty body.
    start_audio_response($state['type'] !== '' ? $state['type'] : 'application/octet-stream', '0');
    exit;
}

function stream_audio_streams(string $url, array $target): ?string
{
    list($stream, $status, $type, $redirect, $length) = open_stream($url, $target, 'audio/*', 30);
    if ($redirect !== null) {
        fclose($stream);
        return $redirect;
    }
    if ($status >= 400) {
        fclose($stream);
        fail(502, 'Upstream returned ' . $status);
    }
    if (!is_audio_type($type)) {
        fclose($stream);
        fail(415, 'That URL is not audio');
    }
    if ($length !== null && ctype_digit($length) && (int) $length > MAX_AUDIO_BYTES) {
        fclose($stream);
        fail(502, 'Upstream response too large');
    }

    start_audio_response($type, $length);
    $sent = 0;
    while (!feof($stream) && $sent <= MAX_AUDIO_BYTES) {
        $chunk = fread($stream, 65536);
        if ($chunk === false || $chunk === '') {
            break;
        }
        $sent += strlen($chunk);
        echo $chunk;
        flush();
    }
    fclose($stream);
    exit;
}

/** Location headers may be relative to the URL that produced them. */
function resolve_redirect(string $base, string $location): string
{
    if (preg_match('#^https?://#i', $location)) {
        return $location;
    }
    $parts = parse_url($base);
    $root  = $parts['scheme'] . '://' . $parts['host']
        . (isset($parts['port']) ? ':' . $parts['port'] : '');
    if (strpos($location, '/') === 0) {
        return $root . $location;
    }
    $path = isset($parts['path']) ? $parts['path'] : '/';
    return $root . substr($path, 0, (int) strrpos($path, '/') + 1) . $location;
}

function feed_cache_path(string $url): ?string
{
    $dir = data_dir();
    if ($dir === null) {
        return null;
    }
    $cache = $dir . '/feed-cache';
    if (!is_dir($cache) && !@mkdir($cache, 0700, true) && !is_dir($cache)) {
        return null;
    }
    return is_writable($cache) ? $cache . '/' . sha1($url) . '.xml' : null;
}

function cached_feed(string $url): string
{
    $path = feed_cache_path($url);
    if ($path !== null && is_file($path) && (time() - filemtime($path)) < FEED_CACHE_TTL) {
        $hit = @file_get_contents($path);
        if ($hit !== false) {
            return $hit;
        }
    }

    $result = fetch_url($url, 'application/rss+xml, application/xml, text/xml, */*', MAX_FEED_BYTES);
    if ($path !== null) {
        @file_put_contents($path, $result['body'], LOCK_EX);
    }
    return $result['body'];
}

// ---- routes ---------------------------------------------------------------

function handle_feed(): void
{
    guard_proxy('feed');
    $url = isset($_GET['url']) ? trim((string) $_GET['url']) : '';
    if ($url === '') {
        fail(400, 'Missing url');
    }
    send_body(cached_feed($url), 'application/xml; charset=utf-8', 'public, max-age=300');
}

function handle_search(): void
{
    guard_proxy('search');
    $term = isset($_GET['q']) ? trim((string) $_GET['q']) : '';
    if ($term === '') {
        send_body('{"results":[]}', 'application/json; charset=utf-8', 'no-store');
    }
    $limit  = clamp_int(isset($_GET['limit']) ? $_GET['limit'] : '', 1, 200, 50);
    $target = ITUNES_SEARCH . '?' . http_build_query(array(
        'term'   => $term,
        'media'  => 'podcast',
        'entity' => 'podcast',
        'limit'  => $limit,
    ));
    $result = fetch_url($target, 'application/json', MAX_FEED_BYTES);
    send_body($result['body'], 'application/json; charset=utf-8', 'public, max-age=600');
}

function handle_charts(): void
{
    guard_proxy('charts');
    $genre  = isset($_GET['genre']) ? trim((string) $_GET['genre']) : '';
    $limit  = clamp_int(isset($_GET['limit']) ? $_GET['limit'] : '', 1, 100, 30);
    $target = ITUNES_CHARTS . '/limit=' . $limit;
    if ($genre !== '' && ctype_digit($genre)) {
        $target .= '/genre=' . $genre;
    }
    $target .= '/json';
    $result = fetch_url($target, 'application/json', MAX_FEED_BYTES);
    send_body($result['body'], 'application/json; charset=utf-8', 'public, max-age=3600');
}

function handle_audio(): void
{
    guard_proxy('audio');
    $url = isset($_GET['url']) ? trim((string) $_GET['url']) : '';
    if ($url === '') {
        fail(400, 'Missing url');
    }
    stream_audio($url);
}
