<?php
/**
 * Front controller for /api/*.
 *
 * .htaccess rewrites every /api/<name> to this file; the last path segment
 * selects the route. Nothing under lib/ is reachable on its own - each file
 * checks PODCAST_APP and 404s if requested directly.
 */

declare(strict_types=1);

define('PODCAST_APP', true);

require __DIR__ . '/lib/bootstrap.php';
require __DIR__ . '/lib/db.php';
require __DIR__ . '/lib/accounts.php';
require __DIR__ . '/lib/sync.php';
require __DIR__ . '/lib/proxy.php';

$path   = (string) parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$route  = basename($path);
$method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';

// State-changing routes are JSON-only. A browser cannot send a cross-site
// request with this content type without a CORS preflight, which never
// succeeds here - that plus SameSite on the cookie is the CSRF defence.
function require_json_post(): array
{
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
        fail(405, 'Use POST for this endpoint');
    }
    $type = $_SERVER['CONTENT_TYPE'] ?? ($_SERVER['HTTP_CONTENT_TYPE'] ?? '');
    if (stripos($type, 'application/json') === false) {
        fail(415, 'Send JSON');
    }
    return json_input();
}

switch ($route) {
    case 'health':
        $dir = data_dir();
        json_out(array(
            'ok'              => true,
            'php'             => PHP_VERSION,
            'curl'            => function_exists('curl_init'),
            'allow_url_fopen' => (bool) ini_get('allow_url_fopen'),
            'pdo_drivers'     => PDO::getAvailableDrivers(),
            'data_dir'        => $dir !== null,
            'data_dir_public' => data_dir_is_public(),
            'registration'    => REGISTRATION,
            'memory_limit'    => ini_get('memory_limit'),
            'max_execution'   => ini_get('max_execution_time'),
            'post_max_size'   => ini_get('post_max_size'),
        ));
        // no break - json_out exits

    case 'register':
        handle_register(require_json_post());

    case 'login':
        handle_login(require_json_post());

    case 'logout':
        handle_logout();

    case 'me':
        handle_me();

    case 'password':
        handle_change_password(require_json_post());

    case 'sync':
        if ($method === 'POST') {
            require_json_post();
        }
        handle_sync();

    case 'feed':
        handle_feed();

    case 'search':
        handle_search();

    case 'charts':
        handle_charts();

    case 'audio':
        handle_audio();

    default:
        fail(404, 'Unknown endpoint');
}
