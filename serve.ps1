param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 8000,
    [switch]$NoBrowser
)

$projectRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$projectBoundary = $projectRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$mimeTypes = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.mjs'  = 'text/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.ico'  = 'image/x-icon'
}

function Send-Response {
    param(
        [System.Net.Sockets.NetworkStream]$Stream,
        [int]$Status,
        [string]$Reason,
        [byte[]]$Body,
        [string]$ContentType = 'text/plain; charset=utf-8',
        [switch]$HeadOnly,
        [hashtable]$Headers = @{}
    )

    $extraHeaders = ($Headers.GetEnumerator() | ForEach-Object { "$($_.Key): $($_.Value)`r`n" }) -join ''
    $header = "HTTP/1.1 $Status $Reason`r`nContent-Type: $ContentType`r`nContent-Length: $($Body.Length)`r`nCache-Control: no-cache`r`nX-Content-Type-Options: nosniff`r`n$extraHeaders" + "Connection: close`r`n`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    if (-not $HeadOnly -and $Body.Length -gt 0) {
        $Stream.Write($Body, 0, $Body.Length)
    }
}

try {
    $listener.Start()
    $url = "http://localhost:$Port/"
    Write-Host "Mazing Contest is running at $url" -ForegroundColor Green
    Write-Host 'Press Ctrl+C to stop.' -ForegroundColor DarkGray

    if (-not $NoBrowser) {
        try {
            Start-Process $url
        }
        catch {
            Write-Warning "The browser could not be opened automatically. Open $url manually."
        }
    }

    while ($true) {
        $client = $listener.AcceptTcpClient()
        $stream = $null
        try {
            $client.ReceiveTimeout = 5000
            $client.SendTimeout = 5000
            $stream = $client.GetStream()
            $stream.ReadTimeout = 5000
            $stream.WriteTimeout = 5000
            $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
            $requestLine = $reader.ReadLine()

            if ($requestLine -and $requestLine.Length -gt 4096) {
                Send-Response -Stream $stream -Status 414 -Reason 'URI Too Long' -Body ([System.Text.Encoding]::UTF8.GetBytes('Request target is too long'))
                continue
            }

            $requestHeaders = @{}
            $headerLength = 0
            while (($line = $reader.ReadLine()) -ne $null -and $line -ne '') {
                $headerLength += $line.Length
                if ($headerLength -gt 32768) { throw [System.Net.ProtocolViolationException]::new('Request headers are too large.') }
                $separator = $line.IndexOf(':')
                if ($separator -le 0) { throw [System.Net.ProtocolViolationException]::new('Malformed request header.') }
                $name = $line.Substring(0, $separator).Trim()
                $value = $line.Substring($separator + 1).Trim()
                if ($requestHeaders.ContainsKey($name)) {
                    if ($name -ieq 'Host') { throw [System.Net.ProtocolViolationException]::new('Duplicate Host header.') }
                    $requestHeaders[$name] = "$($requestHeaders[$name]), $value"
                }
                else {
                    $requestHeaders[$name] = $value
                }
            }

            if (-not $requestLine -or $requestLine -notmatch '^([A-Z]+)\s+([^\s]+)\s+HTTP/(1\.[01])$') {
                Send-Response -Stream $stream -Status 400 -Reason 'Bad Request' -Body ([System.Text.Encoding]::UTF8.GetBytes('Bad request'))
                continue
            }

            $method = $Matches[1]
            $requestTarget = $Matches[2]
            $httpVersion = $Matches[3]
            $headOnly = $method -eq 'HEAD'
            if ($method -notin @('GET', 'HEAD')) {
                Send-Response -Stream $stream -Status 405 -Reason 'Method Not Allowed' -Body ([System.Text.Encoding]::UTF8.GetBytes('Method not allowed')) -Headers @{ Allow = 'GET, HEAD' }
                continue
            }

            $allowedHosts = @("localhost:$Port", "127.0.0.1:$Port")
            $hostHeader = $requestHeaders['Host']
            if (($httpVersion -eq '1.1' -and -not $hostHeader) -or ($hostHeader -and $hostHeader -notin $allowedHosts)) {
                Send-Response -Stream $stream -Status 403 -Reason 'Forbidden' -Body ([System.Text.Encoding]::UTF8.GetBytes('Host is not allowed')) -HeadOnly:$headOnly
                continue
            }

            if (-not $requestTarget.StartsWith('/')) {
                Send-Response -Stream $stream -Status 400 -Reason 'Bad Request' -Body ([System.Text.Encoding]::UTF8.GetBytes('Bad request')) -HeadOnly:$headOnly
                continue
            }

            $requestPath = [System.Uri]::UnescapeDataString(($requestTarget -split '\?')[0])
            if ($requestPath -eq '/') { $requestPath = '/index.html' }
            $relativePath = $requestPath.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
            $filePath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($projectRoot, $relativePath))

            if ($filePath -ne $projectRoot -and -not $filePath.StartsWith($projectBoundary, [System.StringComparison]::OrdinalIgnoreCase)) {
                Send-Response -Stream $stream -Status 403 -Reason 'Forbidden' -Body ([System.Text.Encoding]::UTF8.GetBytes('Forbidden')) -HeadOnly:$headOnly
                continue
            }

            if (-not [System.IO.File]::Exists($filePath)) {
                Send-Response -Stream $stream -Status 404 -Reason 'Not Found' -Body ([System.Text.Encoding]::UTF8.GetBytes('Not found')) -HeadOnly:$headOnly
                continue
            }

            $extension = [System.IO.Path]::GetExtension($filePath).ToLowerInvariant()
            if (-not $mimeTypes.ContainsKey($extension)) {
                Send-Response -Stream $stream -Status 403 -Reason 'Forbidden' -Body ([System.Text.Encoding]::UTF8.GetBytes('File type is not served')) -HeadOnly:$headOnly
                continue
            }

            $body = [System.IO.File]::ReadAllBytes($filePath)
            Send-Response -Stream $stream -Status 200 -Reason 'OK' -Body $body -ContentType $mimeTypes[$extension] -HeadOnly:$headOnly
        }
        catch {
            Write-Warning $_.Exception.Message
            if ($stream -and $stream.CanWrite) {
                try {
                    Send-Response -Stream $stream -Status 400 -Reason 'Bad Request' -Body ([System.Text.Encoding]::UTF8.GetBytes('Bad request'))
                }
                catch { }
            }
        }
        finally {
            $client.Dispose()
        }
    }
}
finally {
    $listener.Stop()
}
