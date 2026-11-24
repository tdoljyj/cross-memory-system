# read-pool-tags.ps1 (docs/architecture.md section 9.1, the node reboot fallback; src/node-reboot.mjs reads its output).
#
# Read-only and unprivileged: the kernel's pool tag table through NtQuerySystemInformation(SystemPoolTagInformation = 22), the
# same read D:/w/tmp/leak/toke-count.ps1 made without elevation. Prints one line of JSON and nothing else:
#   {"contract":"clued.independent-ci.pool-tags/1","tags":[{"tag":"Toke","pagedBytes":5619316736,"pagedCount":2582116},...]}
# one entry per tag with paged pool bytes in use (pagedBytes: the tag's PagedUsed; pagedCount: allocations not yet freed). The
# companion never looks at a tag's name to decide: it takes the largest pagedBytes. Any failure: exit 1 and nothing on stdout.
# No Add-Type (it compiles through csc.exe and needs a writable TEMP): the one native call is emitted in memory. ASCII only.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

try {
  if ([IntPtr]::Size -ne 8) { exit 1 }   # the layout below is the 64-bit one
  $name = New-Object Reflection.AssemblyName 'CluedPoolTags'
  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($name, [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $module = $assembly.DefineDynamicModule('CluedPoolTags')
  $type = $module.DefineType('CluedPoolTagsNative', [Reflection.TypeAttributes]'Public, Abstract, Sealed')
  $method = $type.DefinePInvokeMethod('NtQuerySystemInformation', 'ntdll.dll', [Reflection.MethodAttributes]'Public, Static, PinvokeImpl',
    [Reflection.CallingConventions]::Standard, [int], [Type[]]@([int], [IntPtr], [int], [int].MakeByRefType()),
    [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
  $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  $native = $type.CreateType()
  $marshal = [Runtime.InteropServices.Marshal]

  $length = 4MB
  $buffer = [IntPtr]::Zero
  for ($attempt = 0; $attempt -lt 6; $attempt++) {
    $buffer = $marshal::AllocHGlobal($length)
    $needed = 0
    $status = $native::NtQuerySystemInformation(22, $buffer, $length, [ref]$needed)
    if ($status -eq 0) { break }
    $marshal::FreeHGlobal($buffer)
    $buffer = [IntPtr]::Zero
    if ($status -ne -1073741820) { exit 1 }   # anything but STATUS_INFO_LENGTH_MISMATCH (0xC0000004)
    $length = [Math]::Max($length * 2, $needed + 1MB)
  }
  if ($buffer -eq [IntPtr]::Zero) { exit 1 }

  # SYSTEM_POOLTAG_INFORMATION: ULONG Count, then (8-aligned) SYSTEM_POOLTAG[Count] of 40 bytes each:
  #   0 Tag[4], 4 PagedAllocs, 8 PagedFrees, 16 PagedUsed (SIZE_T), 24 NonPagedAllocs, 28 NonPagedFrees, 32 NonPagedUsed (SIZE_T)
  $count = $marshal::ReadInt32($buffer, 0)
  if ($count -lt 1 -or (8 + [int64]$count * 40) -gt $length) { exit 1 }
  $out = New-Object Text.StringBuilder
  [void]$out.Append('{"contract":"clued.independent-ci.pool-tags/1","tags":[')
  $first = $true
  for ($i = 0; $i -lt $count; $i++) {
    $offset = 8 + $i * 40
    $used = $marshal::ReadInt64($buffer, $offset + 16)
    if ($used -le 0) { continue }
    $allocs = [int64]([uint32]($marshal::ReadInt32($buffer, $offset + 4) -band 0xFFFFFFFFL))
    $frees = [int64]([uint32]($marshal::ReadInt32($buffer, $offset + 8) -band 0xFFFFFFFFL))
    $live = $allocs - $frees
    if ($live -lt 0) { $live += 4294967296 }
    $tag = New-Object Text.StringBuilder
    for ($k = 0; $k -lt 4; $k++) {
      $b = $marshal::ReadByte($buffer, $offset + $k)
      if ($b -ge 0x20 -and $b -le 0x7E -and $b -ne 0x22 -and $b -ne 0x5C) { [void]$tag.Append([char]$b) } else { [void]$tag.Append('?') }
    }
    if (-not $first) { [void]$out.Append(',') }
    $first = $false
    [void]$out.Append('{"tag":"').Append($tag.ToString()).Append('","pagedBytes":').Append($used.ToString([Globalization.CultureInfo]::InvariantCulture))
    [void]$out.Append(',"pagedCount":').Append($live.ToString([Globalization.CultureInfo]::InvariantCulture)).Append('}')
  }
  [void]$out.Append(']}')
  $marshal::FreeHGlobal($buffer)
  if ($first) { exit 1 }
  [Console]::Out.Write($out.ToString())
  [Console]::Out.Write("`n")
  exit 0
} catch {
  exit 1
}
