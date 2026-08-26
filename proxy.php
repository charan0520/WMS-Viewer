<?php
declare(strict_types=1);

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$target = trim((string)($_GET['url'] ?? ''));
if ($target === '') {
    send_json(400, ['error' => 'Missing url query parameter']);
}

if (!preg_match('/^https?:\/\//i', $target)) {
    send_json(400, ['error' => 'Only http and https URLs are allowed']);
}

$result = function_exists('curl_init')
    ? proxy_with_curl($target)
    : proxy_with_stream($target);

if ($result['ok'] !== true) {
    send_json(502, ['error' => $result['error']]);
}

http_response_code($result['status'] > 0 ? $result['status'] : 200);
if ($result['content_type'] !== '') {
    header('Content-Type: ' . $result['content_type']);
}
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');
echo $result['body'];

function proxy_with_curl(string $target): array
{
    $targetParts = parse_url($target);
    $referer = isset($targetParts['scheme'], $targetParts['host'])
        ? $targetParts['scheme'] . '://' . $targetParts['host'] . '/'
        : '';

    $headerSets = [
        [
            'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language: en-US,en;q=0.9',
            'Connection: keep-alive',
            'Sec-Fetch-Dest: empty',
            'Sec-Fetch-Mode: cors',
            'Sec-Fetch-Site: cross-site',
        ],
        [
            'Accept: */*',
            'Accept-Language: en-US,en;q=0.9',
        ],
    ];

    if ($referer !== '') {
        $headerSets[0][] = 'Referer: ' . $referer;
        $headerSets[1][] = 'Referer: ' . $referer;
    }

    foreach ($headerSets as $headers) {
        $ch = curl_init($target);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_TIMEOUT => 30,
            CURLOPT_HEADER => true,
            CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_ENCODING => '',
            // Local development workaround for incomplete CA trust on this machine.
            CURLOPT_SSL_VERIFYPEER => false,
            CURLOPT_SSL_VERIFYHOST => 0,
        ]);

        $response = curl_exec($ch);
        if ($response === false) {
            $error = curl_error($ch);
            curl_close($ch);
            return [
                'ok' => false,
                'error' => $error !== '' ? $error : 'Unknown cURL error',
            ];
        }

        $statusCode = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $headerSize = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
        $contentType = (string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
        $body = substr($response, $headerSize);
        curl_close($ch);

        if ($statusCode !== 403) {
            return [
                'ok' => true,
                'status' => $statusCode,
                'content_type' => $contentType,
                'body' => $body,
            ];
        }
    }

    return [
        'ok' => true,
        'status' => $statusCode,
        'content_type' => $contentType,
        'body' => $body,
    ];
}

function proxy_with_stream(string $target): array
{
    $targetParts = parse_url($target);
    $referer = isset($targetParts['scheme'], $targetParts['host'])
        ? $targetParts['scheme'] . '://' . $targetParts['host'] . '/'
        : '';

    $headerSets = [
        [
            'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language: en-US,en;q=0.9',
            'Connection: close',
            'Sec-Fetch-Dest: empty',
            'Sec-Fetch-Mode: cors',
            'Sec-Fetch-Site: cross-site',
        ],
        [
            'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Accept: */*',
            'Accept-Language: en-US,en;q=0.9',
            'Connection: close',
        ],
    ];

    if ($referer !== '') {
        $headerSets[0][] = 'Referer: ' . $referer;
        $headerSets[1][] = 'Referer: ' . $referer;
    }

    foreach ($headerSets as $headers) {
        $context = stream_context_create([
            'http' => [
                'method' => 'GET',
                'timeout' => 30,
                'ignore_errors' => true,
                'header' => implode("\r\n", $headers) . "\r\n",
            ],
            'ssl' => [
                // Local development workaround for incomplete CA trust on this machine.
                'verify_peer' => false,
                'verify_peer_name' => false,
            ],
        ]);

        $body = @file_get_contents($target, false, $context);
        if ($body === false) {
            $error = error_get_last();
            return [
                'ok' => false,
                'error' => $error['message'] ?? 'stream request failed',
            ];
        }

        $headers = $http_response_header ?? [];
        $statusCode = 200;
        $contentType = '';

        foreach ($headers as $headerLine) {
            if (preg_match('/^HTTP\/\S+\s+(\d{3})/i', $headerLine, $matches)) {
                $statusCode = (int) $matches[1];
            }
            if (stripos($headerLine, 'Content-Type:') === 0) {
                $contentType = trim(substr($headerLine, strlen('Content-Type:')));
            }
        }

        if ($statusCode !== 403) {
            return [
                'ok' => true,
                'status' => $statusCode,
                'content_type' => $contentType,
                'body' => $body,
            ];
        }
    }

    return [
        'ok' => true,
        'status' => $statusCode,
        'content_type' => $contentType,
        'body' => $body,
    ];
}

function send_json(int $status, array $payload): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload);
    exit;
}
