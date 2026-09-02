<?php
/**
 * Accounts. Web clients authenticate with an HttpOnly cookie, the Android app
 * with a bearer token; both are the same opaque token, and only its SHA-256 is
 * stored, so a database leak does not hand over live sessions.
 */

declare(strict_types=1);

if (!defined('PODCAST_APP')) {
    http_response_code(404);
    exit;
}

const COOKIE_NAME = 'pc_token';

function invite_code(): string
{
    $dir = data_dir();
    if ($dir === null) {
        return '';
    }
    $path = $dir . '/invite-code.txt';
    if (!is_file($path)) {
        // Generated once on first use; read it over SSH or the file manager.
        @file_put_contents($path, bin2hex(random_bytes(4)) . "\n", LOCK_EX);
        @chmod($path, 0600);
    }
    $code = @file_get_contents($path);
    return $code === false ? '' : trim($code);
}

function issue_token(int $userId, string $device): string
{
    $token = bin2hex(random_bytes(32));
    $statement = db()->prepare(
        'INSERT INTO tokens (user_id, token_hash, device, created_at, expires_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?)'
    );
    $statement->execute(array(
        $userId,
        hash('sha256', $token),
        substr($device, 0, 64),
        now(),
        now() + TOKEN_TTL,
        now(),
    ));
    return $token;
}

function set_auth_cookie(string $token): void
{
    $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https');

    setcookie(COOKIE_NAME, $token, array(
        'expires'  => now() + TOKEN_TTL,
        'path'     => '/',
        'secure'   => $secure,
        'httponly' => true,
        'samesite' => 'Lax',
    ));
}

function clear_auth_cookie(): void
{
    setcookie(COOKIE_NAME, '', array(
        'expires'  => now() - 3600,
        'path'     => '/',
        'httponly' => true,
        'samesite' => 'Lax',
    ));
}

function presented_token(): string
{
    $header = '';
    if (isset($_SERVER['HTTP_AUTHORIZATION'])) {
        $header = $_SERVER['HTTP_AUTHORIZATION'];
    } elseif (function_exists('apache_request_headers')) {
        $headers = apache_request_headers();
        foreach ($headers as $name => $value) {
            if (strtolower($name) === 'authorization') {
                $header = $value;
                break;
            }
        }
    }
    if (stripos($header, 'Bearer ') === 0) {
        return trim(substr($header, 7));
    }
    return isset($_COOKIE[COOKIE_NAME]) ? (string) $_COOKIE[COOKIE_NAME] : '';
}

/** @return array|null the user row, or null when unauthenticated. */
function current_user(): ?array
{
    $token = presented_token();
    if ($token === '' || !ctype_xdigit($token)) {
        return null;
    }

    $statement = db()->prepare(
        'SELECT u.id, u.username, u.display_name, t.id AS token_id, t.expires_at
         FROM tokens t JOIN users u ON u.id = t.user_id
         WHERE t.token_hash = ?'
    );
    $statement->execute(array(hash('sha256', $token)));
    $row = $statement->fetch();
    if (!$row) {
        return null;
    }
    if ((int) $row['expires_at'] < now()) {
        db()->prepare('DELETE FROM tokens WHERE id = ?')->execute(array($row['token_id']));
        return null;
    }

    // Touch at most once an hour; every sync would otherwise be a write.
    if (now() - (int) $row['expires_at'] + TOKEN_TTL > 3600) {
        db()->prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?')
            ->execute(array(now(), $row['token_id']));
    }
    return $row;
}

function require_user(): array
{
    $user = current_user();
    if ($user === null) {
        fail(401, 'Sign in to continue');
    }
    return $user;
}

function normalise_username(string $raw): string
{
    return strtolower(trim($raw));
}

function handle_register(array $input): void
{
    if (REGISTRATION === 'closed') {
        fail(403, 'This server is not accepting new accounts');
    }

    $username = normalise_username(field($input, 'username'));
    $password = field($input, 'password');
    $display  = field($input, 'displayName', $username);

    if (!preg_match('/^[a-z0-9._-]{3,32}$/', $username)) {
        fail(400, 'Usernames are 3-32 characters: letters, numbers, dot, dash, underscore');
    }
    if (strlen($password) < 8) {
        fail(400, 'Password must be at least 8 characters');
    }
    if (REGISTRATION === 'invite') {
        $supplied = field($input, 'inviteCode');
        $expected = invite_code();
        if ($expected === '' || !hash_equals($expected, $supplied)) {
            fail(403, 'That invite code is not right');
        }
    }

    $exists = db()->prepare('SELECT id FROM users WHERE username = ?');
    $exists->execute(array($username));
    if ($exists->fetch()) {
        fail(409, 'That username is taken');
    }

    $insert = db()->prepare(
        'INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)'
    );
    $insert->execute(array(
        $username,
        substr($display, 0, 120),
        password_hash($password, PASSWORD_DEFAULT),
        now(),
    ));

    $userId = (int) db()->lastInsertId();
    $token  = issue_token($userId, field($input, 'device', 'web'));
    set_auth_cookie($token);

    json_out(array(
        'token' => $token,
        'user'  => array('username' => $username, 'displayName' => $display),
    ), 201);
}

function handle_login(array $input): void
{
    $username = normalise_username(field($input, 'username'));
    $password = field($input, 'password');

    $statement = db()->prepare(
        'SELECT id, username, display_name, password_hash, failed_attempts, locked_until
         FROM users WHERE username = ?'
    );
    $statement->execute(array($username));
    $user = $statement->fetch();

    if ($user && (int) $user['locked_until'] > now()) {
        $wait = (int) ceil(((int) $user['locked_until'] - now()) / 60);
        fail(429, 'Too many attempts. Try again in ' . $wait . ' minutes.');
    }

    // Hash even when the user does not exist, so timing does not reveal which
    // usernames are real.
    $hash = $user ? $user['password_hash'] : '$2y$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
    $ok = password_verify($password, $hash) && $user;

    if (!$ok) {
        if ($user) {
            $fails = (int) $user['failed_attempts'] + 1;
            $lock  = $fails >= MAX_LOGIN_FAILS ? now() + LOCKOUT_SECONDS : 0;
            db()->prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
                ->execute(array($lock ? 0 : $fails, $lock, $user['id']));
        }
        fail(401, 'Wrong username or password');
    }

    db()->prepare('UPDATE users SET failed_attempts = 0, locked_until = 0 WHERE id = ?')
        ->execute(array($user['id']));

    $token = issue_token((int) $user['id'], field($input, 'device', 'web'));
    set_auth_cookie($token);

    json_out(array(
        'token' => $token,
        'user'  => array(
            'username'    => $user['username'],
            'displayName' => $user['display_name'],
        ),
    ));
}

function handle_logout(): void
{
    $token = presented_token();
    if ($token !== '' && ctype_xdigit($token)) {
        db()->prepare('DELETE FROM tokens WHERE token_hash = ?')
            ->execute(array(hash('sha256', $token)));
    }
    clear_auth_cookie();
    json_out(array('ok' => true));
}

function handle_me(): void
{
    $user = current_user();
    if ($user === null) {
        json_out(array('user' => null));
    }
    json_out(array('user' => array(
        'username'    => $user['username'],
        'displayName' => $user['display_name'],
    )));
}

function handle_change_password(array $input): void
{
    $user = require_user();
    $current = field($input, 'currentPassword');
    $next    = field($input, 'newPassword');

    if (strlen($next) < 8) {
        fail(400, 'Password must be at least 8 characters');
    }

    $statement = db()->prepare('SELECT password_hash FROM users WHERE id = ?');
    $statement->execute(array($user['id']));
    $row = $statement->fetch();
    if (!$row || !password_verify($current, $row['password_hash'])) {
        fail(401, 'Current password is wrong');
    }

    db()->prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        ->execute(array(password_hash($next, PASSWORD_DEFAULT), $user['id']));

    // Changing a password should end every other session.
    db()->prepare('DELETE FROM tokens WHERE user_id = ? AND id <> ?')
        ->execute(array($user['id'], $user['token_id']));

    json_out(array('ok' => true));
}
