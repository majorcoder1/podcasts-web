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
 * Reject anything that is not a plain public http(s) URL.
 *
 * This script can reach the host's own network, so an unguarded ?url= would let
 * any visitor probe localhost and whatever sits behind it. Every redirect hop
 * is re-checked by fetch_url() for the same reason.
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

    $host = $parts['host'];
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
        $public = filter_var(
            $address,
            FILTER_VALIDATE_IP,
            FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE
        );
        if ($public === false) {
            fail(403, 'That host is not publicly routable');
        }
    }

    return $parts;
}

/**
 * Fetch a validated URL. Redirects are followed by hand so each hop is
 * re-validated; cURL's own follower would skip that check entirely.
 *
 * @return array{body:string,type:string}
 */
function fetch_url(string $url, string $accept, int $limit): array
{
    $hops = 0;

    while (true) {
        assert_public_url($url);

        $result = function_exists('curl_init')
            ? fetch_with_curl($url, $accept, $limit)
            : fetch_with_streams($url, $accept, $limit);

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

function fetch_with_curl(string $url, string $accept, int $limit): array
{
    $handle = curl_init($url);
    curl_setopt_array($handle, array(
        CURLOPT_RETURNTRANSFER   => true,
        CURLOPT_FOLLOWLOCATION   => false,
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
    $target = (string) curl_getinfo($handle, CURLINFO_REDIRECT_URL);
    $error  = curl_error($handle);
    curl_close($handle);

    if ($body === false && $error !== '') {
        fail(504, 'Upstream did not respond');
    }
    if ($status >= 300 && $status < 400 && $target !== '') {
        return array('redirect' => $target, 'status' => $status, 'body' => '', 'type' => '');
    }
    return array(
        'redirect' => null,
        'status'   => $status,
        'body'     => $body === false ? '' : $body,
        'type'     => $type !== '' ? $type : 'application/octet-stream',
    );
}

function fetch_with_streams(string $url, string $accept, int $limit): array
{
    if (!ini_get('allow_url_fopen')) {
        fail(500, 'This host has neither cURL nor allow_url_fopen enabled');
    }

    $context = stream_context_create(array('http' => array(
        'method'          => 'GET',
        'header'          => 'User-Agent: ' . USER_AGENT . "\r\nAccept: " . $accept . "\r\n",
        'timeout'         => FETCH_TIMEOUT,
        'follow_location' => 0,
        'ignore_errors'   => true,
    )));

    $stream = @fopen($url, 'rb', false, $context);
    if ($stream === false) {
        fail(504, 'Upstream did not respond');
    }

    $body = @stream_get_contents($stream, $limit + 1);
    $meta = stream_get_meta_data($stream);
    fclose($stream);

    $status   = 200;
    $type     = 'application/octet-stream';
    $redirect = null;
    foreach ($meta['wrapper_data'] as $line) {
        if (preg_match('#^HTTP/[\d.]+\s+(\d{3})#i', $line, $match)) {
            $status = (int) $match[1];
        } elseif (stripos($line, 'Location:') === 0) {
            $redirect = trim(substr($line, 9));
        } elseif (stripos($line, 'Content-Type:') === 0) {
            $type = trim(substr($line, 13));
        }
    }

    if ($status >= 300 && $status < 400 && $redirect !== null) {
        return array('redirect' => $redirect, 'status' => $status, 'body' => '', 'type' => '');
    }
    return array(
        'redirect' => null,
        'status'   => $status,
        'body'     => $body === false ? '' : $body,
        'type'     => $type,
    );
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
    $url = isset($_GET['url']) ? trim((string) $_GET['url']) : '';
    if ($url === '') {
        fail(400, 'Missing url');
    }
    send_body(cached_feed($url), 'application/xml; charset=utf-8', 'public, max-age=300');
}

function handle_search(): void
{
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
    $url = isset($_GET['url']) ? trim((string) $_GET['url']) : '';
    if ($url === '') {
        fail(400, 'Missing url');
    }
    $result = fetch_url($url, 'audio/*', MAX_AUDIO_BYTES);
    $type   = strtolower($result['type']);
    if (strpos($type, 'audio/') !== 0
        && strpos($type, 'video/') !== 0
        && strpos($type, 'application/octet-stream') !== 0) {
        fail(415, 'That URL is not audio');
    }
    send_body($result['body'], $result['type'], 'public, max-age=86400');
}
