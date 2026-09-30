<?php
/**
 * One-shot deploy endpoint.
 *
 * POST a zip of the site here with the shared key and it replaces the files in
 * place, so updates do not need a manual upload.
 *
 *   curl -sS -F key=<key> -F bundle=@site.zip https://podcast.4thepeople.live/deploy.php
 *
 * This writes files into the live site, so it is deliberately narrow:
 *
 *   - the key lives in deploy-key.php, which is never committed
 *   - HTTPS only, and the key is compared in constant time
 *   - entries are rejected on "..", absolute paths, backslashes or control
 *     characters, and each extracted path is re-checked against the site root
 *   - data/ is never touched, so the database and invite code survive
 *   - this file and its key cannot overwrite themselves and lock you out
 *
 * Delete this file to turn deploys off again.
 */

declare(strict_types=1);

const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const SKIP_PREFIXES = array('data/', 'deploy.php', 'deploy-key.php');

function bail(int $status, string $message): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode(array('error' => $message));
    exit;
}

$secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
    || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
if (!$secure) {
    bail(400, 'Use HTTPS');
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    bail(405, 'POST a bundle');
}

$keyFile = __DIR__ . '/deploy-key.php';
if (!is_file($keyFile)) {
    bail(503, 'No deploy key installed');
}
$expected = trim((string) (include $keyFile));
$supplied = (string) ($_POST['key'] ?? '');
if ($expected === '' || strlen($supplied) < 32 || !hash_equals($expected, $supplied)) {
    // Same answer either way, so this cannot be used to probe for the key.
    usleep(random_int(100000, 300000));
    bail(403, 'Rejected');
}

if (!isset($_FILES['bundle']) || $_FILES['bundle']['error'] !== UPLOAD_ERR_OK) {
    bail(400, 'No bundle received');
}
if ($_FILES['bundle']['size'] > MAX_BUNDLE_BYTES) {
    bail(413, 'Bundle too large');
}
if (!class_exists('ZipArchive')) {
    bail(500, 'This host has no ZipArchive');
}

$zip = new ZipArchive();
if ($zip->open($_FILES['bundle']['tmp_name']) !== true) {
    bail(400, 'Not a readable zip');
}

$root = realpath(__DIR__);
$written = 0;
$skipped = array();

for ($i = 0; $i < $zip->numFiles; $i++) {
    $name = $zip->getNameIndex($i);
    if ($name === false || $name === '' || substr($name, -1) === '/') {
        continue;
    }

    // Reject anything that could climb out of the site root.
    if (strpos($name, '..') !== false
        || strpos($name, "\0") !== false
        || strpos($name, '\\') !== false
        || $name[0] === '/'
        || preg_match('/[\x00-\x1f]/', $name)) {
        $skipped[] = $name;
        continue;
    }

    $protected = false;
    foreach (SKIP_PREFIXES as $prefix) {
        if (strpos($name, $prefix) === 0) {
            $protected = true;
            break;
        }
    }
    if ($protected) {
        $skipped[] = $name;
        continue;
    }

    $target = $root . '/' . $name;
    $dir = dirname($target);
    if (!is_dir($dir) && !@mkdir($dir, 0755, true) && !is_dir($dir)) {
        $skipped[] = $name;
        continue;
    }

    // Re-check after resolving: symlinks and odd names can still escape.
    $realDir = realpath($dir);
    if ($realDir === false || strpos($realDir, $root) !== 0) {
        $skipped[] = $name;
        continue;
    }

    $stream = $zip->getStream($name);
    if ($stream === false) {
        $skipped[] = $name;
        continue;
    }
    $out = @fopen($target, 'wb');
    if ($out === false) {
        fclose($stream);
        $skipped[] = $name;
        continue;
    }
    stream_copy_to_stream($stream, $out);
    fclose($out);
    fclose($stream);
    $written++;
}
$zip->close();

header('Content-Type: application/json');
echo json_encode(array(
    'ok'       => true,
    'written'  => $written,
    'skipped'  => $skipped,
    'deployed' => gmdate('c'),
));
