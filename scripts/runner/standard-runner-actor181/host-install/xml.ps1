function Require([bool]$ok,[string]$code){if(-not $ok){throw $code}}
function Hash([string]$path){(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
function BytesHash([byte[]]$bytes){[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-','').ToLowerInvariant()}
function ReadBoundBytes([string]$path,[int]$limit){NoReparse $path;$i=Get-Item -LiteralPath $path -Force;Require (-not $i.PSIsContainer -and $i.Length -le $limit) 'READ_FILE_BOUND';$s=[IO.FileStream]::new($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{$b=New-Object byte[] ($limit+1);$n=0;while($n -lt $b.Length){$count=$s.Read($b,$n,$b.Length-$n);if($count -eq 0){break};$n+=$count};Require ($n -le $limit) 'READ_STREAM_BOUND';$result=New-Object byte[] $n;[Array]::Copy($b,$result,$n);return ,$result}finally{$s.Dispose()}}
function JsonNew([string]$path,$value,[int]$limit=32768){Require ($limit -in @(32768,33554432)) 'EVIDENCE_CLASS_LIMIT';$b=[Text.UTF8Encoding]::new($false).GetBytes(($value|ConvertTo-Json -Depth 12 -Compress));Require ($b.Length -le $limit) 'EVIDENCE_BOUND';$s=[IO.FileStream]::new($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);try{$s.Write($b,0,$b.Length);$s.Flush($true)}finally{$s.Dispose()}}
function NoReparse([string]$path){$p=[IO.Path]::GetFullPath($path);while($p){$i=Get-Item -LiteralPath $p -Force;Require (-not ($i.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'REPARSE_BOUNDARY';$p=[IO.Path]::GetDirectoryName($p)}}
function MachineRuntimeAcl([string]$path){
 $trusted=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');$p=[IO.Path]::GetFullPath($path)
 while($p){$acl=Get-Acl -LiteralPath $p;$owner=if($acl.Owner -match '^S-1-'){([Security.Principal.SecurityIdentifier]::new($acl.Owner)).Value}else{([Security.Principal.NTAccount]::new($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value};Require ($owner -in $trusted) 'RUNTIME_OWNER';$mask=if($p -eq [IO.Path]::GetPathRoot($p)){0x500D0040}else{0x500D0156};foreach($ace in $acl.Access){if($ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or ($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)){continue};$sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($sid -notin $trusted){Require (([long]$ace.FileSystemRights -band $mask) -eq 0) 'RUNTIME_NONADMIN_WRITE'}};$p=[IO.Path]::GetDirectoryName($p)}
}
function Quote([string]$value){Require ($value -notmatch '[\r\n\x00]') 'ARG_TEXT';'"'+([regex]::Replace([regex]::Replace($value,'(\\*)"','$1$1\"'),'(\\+)$','$1$1'))+'"'}
function ExactKeys($value,[string[]]$keys){Require ($null -ne $value -and $value -is [pscustomobject]) 'JSON_OBJECT';$actual=@($value.PSObject.Properties.Name);Require ($actual.Count -eq $keys.Count) 'JSON_FIELDS';foreach($k in $keys){Require ($actual -ccontains $k) 'JSON_FIELDS'}}
function ParseJson([byte[]]$bytes){Require ($bytes.Length -le 33554432) 'JSON_BATCH_BOUND';$raw=[Text.UTF8Encoding]::new($false,$true).GetString($bytes);$raw|ConvertFrom-Json}
function SafeJson([string]$path,[string]$owner){$end=[DateTime]::UtcNow.AddSeconds(2);while($true){try{return (ParseJson ([CluedQualification181.SafeEvidence]::Read($path,32768,$owner)))}catch{$e=$_.Exception;while($null -ne $e.InnerException){$e=$e.InnerException};if($e -is [ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq 32 -and [DateTime]::UtcNow -lt $end){Start-Sleep -Milliseconds 20;continue};throw}}}
function AbsentTask($folder,[string]$name){try{$null=$folder.GetTask($name);throw 'TASK_COLLISION'}catch{if($_.Exception.Message -ceq 'TASK_COLLISION'){throw};$e=$_.Exception;while($null -ne $e.InnerException){$e=$e.InnerException};Require ($e.HResult -eq -2147024894) 'TASK_QUERY_UNKNOWN'}}
function SameArgv([string[]]$a,[string[]]$b){Require ($a.Count -eq $b.Count) 'ARG_COUNT';for($i=0;$i -lt $a.Count;$i++){Require ($a[$i] -ceq $b[$i]) 'ARG_IDENTITY'}}
function TaskOne($task,[string]$expectedXmlHash){$hash=BytesHash ([Text.Encoding]::UTF8.GetBytes([string]$task.Xml));Require ($expectedXmlHash -cmatch '^[0-9a-f]{64}$' -and $hash -ceq $expectedXmlHash) 'TASK_VALIDATED_XML_CHANGED';$items=$task.GetInstances(0);Require ($items.Count -eq 1) 'TASK_NO_SINGLE_INSTANCE';$item=$items.Item(1);Require ($item.EnginePID -gt 0 -and $item.State -eq 4) 'TASK_INSTANCE_NOT_RUNNING';@{pid=[int]$item.EnginePID;guid=[string]$item.InstanceGuid;xml_hash=$hash}}
function TaskXmlDocument([string]$text){
 $settings=[Xml.XmlReaderSettings]::new();$settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit;$settings.XmlResolver=$null;$settings.MaxCharactersInDocument=65536
 $reader=[Xml.XmlReader]::Create([IO.StringReader]::new($text),$settings);$doc=[Xml.XmlDocument]::new();$doc.XmlResolver=$null;try{$doc.Load($reader)}finally{$reader.Dispose()};Require ($doc.DocumentElement.LocalName -ceq 'Task' -and $doc.DocumentElement.NamespaceURI -ceq 'http://schemas.microsoft.com/windows/2004/02/mit/task') 'REGISTERED_TASK_XML_ROOT';return ,$doc
}
function TaskXmlShape([Xml.XmlNode]$node){
 # Prefix, attribute order and formatting whitespace have no task semantics.
 $parts=[Collections.Generic.List[string]]::new();$parts.Add($node.NamespaceURI);$parts.Add($node.LocalName)
 $attrs=@($node.Attributes|Where-Object {$_.NamespaceURI -cne 'http://www.w3.org/2000/xmlns/'}|Sort-Object NamespaceURI,LocalName)
 $parts.Add([string]$attrs.Count);foreach($a in $attrs){$parts.Add($a.NamespaceURI);$parts.Add($a.LocalName);$parts.Add($a.Value)}
 foreach($child in $node.ChildNodes){if($child.NodeType -eq [Xml.XmlNodeType]::Element){$parts.Add('element');$parts.Add((TaskXmlShape $child))}elseif($child.NodeType -in @([Xml.XmlNodeType]::Text,[Xml.XmlNodeType]::CDATA)){$parts.Add('text');$parts.Add($child.Value)}elseif($child.NodeType -notin @([Xml.XmlNodeType]::Whitespace,[Xml.XmlNodeType]::SignificantWhitespace,[Xml.XmlNodeType]::Comment)){throw 'REGISTERED_TASK_XML_NODE'}}
 $builder=[Text.StringBuilder]::new();foreach($part in $parts){[void]$builder.Append($part.Length).Append(':').Append($part)};return $builder.ToString()
}
function CheckRegisteredTask($task,[string]$intendedXml,[string]$taskPath,$service){
 # The same Task Scheduler definition parser projects defaults on both sides.
 # NewTask creates only in-memory definitions; it never registers or runs them.
 $raw=[string]$task.Xml;$intendedDefinition=$service.NewTask(0);$intendedDefinition.XmlText=$intendedXml;$actualDefinition=$service.NewTask(0);$actualDefinition.XmlText=$raw
 $expected=TaskXmlDocument ([string]$intendedDefinition.XmlText);$actual=TaskXmlDocument ([string]$actualDefinition.XmlText)
 $ns=[Xml.XmlNamespaceManager]::new($actual.NameTable);$ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
 $en=[Xml.XmlNamespaceManager]::new($expected.NameTable);$en.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
 # Registration may add only this exact task's URI. Other metadata is compared.
 $uri=$actual.SelectSingleNode('/t:Task/t:RegistrationInfo/t:URI',$ns);$wanted=$expected.SelectSingleNode('/t:Task/t:RegistrationInfo/t:URI',$en)
 if($null -eq $wanted -and $null -ne $uri){Require ($uri.InnerText -ceq $taskPath -and $uri.Attributes.Count -eq 0 -and $uri.ChildNodes.Count -eq 1 -and $uri.FirstChild.NodeType -eq [Xml.XmlNodeType]::Text) 'REGISTERED_TASK_URI';$parent=$uri.ParentNode;[void]$parent.RemoveChild($uri);if($parent.ChildNodes.Count -eq 0 -and $parent.Attributes.Count -eq 0 -and $null -eq $expected.SelectSingleNode('/t:Task/t:RegistrationInfo',$en)){[void]$parent.ParentNode.RemoveChild($parent)}}
 Require ((TaskXmlShape $actual.DocumentElement) -ceq (TaskXmlShape $expected.DocumentElement)) 'REGISTERED_TASK_SEMANTIC_MISMATCH'
 return (BytesHash ([Text.Encoding]::UTF8.GetBytes($raw)))
}
function StartValidatedTask($task,[string]$intendedXml,[string]$taskPath,$service){$anchor=CheckRegisteredTask $task $intendedXml $taskPath $service;$null=$task.Run($null);return $anchor}
function CheckWorkerXml([string]$text,$node,[string]$source,[string]$managed){
 $settings=[Xml.XmlReaderSettings]::new();$settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit;$settings.XmlResolver=$null;$settings.MaxCharactersInDocument=65536
 $reader=[Xml.XmlReader]::Create([IO.StringReader]::new($text),$settings);$doc=[Xml.XmlDocument]::new();$doc.XmlResolver=$null;try{$doc.Load($reader)}finally{$reader.Dispose()}
 $ns=[Xml.XmlNamespaceManager]::new($doc.NameTable);$ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
 $get={param($xpath)$n=$doc.SelectSingleNode($xpath,$ns);Require ($null -ne $n) 'XML_REQUIRED_NODE';$n.InnerText}
 $start=&$get '/t:Task/t:Triggers/t:TimeTrigger/t:StartBoundary';$date=[DateTimeOffset]::Parse($start);Require ([math]::Abs(([DateTimeOffset]::UtcNow-$date).TotalSeconds) -lt 600) 'XML_START_BOUNDARY'
 $script=Join-Path $source 'scripts\ci\self-hosted\resource-maintenance\maintenance.py';$registry=Join-Path $source 'config\ci-resource-maintenance.json';$binding=Join-Path $managed 'binding.json'
 $args=&$get '/t:Task/t:Actions/t:Exec/t:Arguments';SameArgv ([CluedQualification181.CommandLine]::Parse(('"'+$node.pythonw+'" '+$args))) @($node.pythonw,$script,'--registry',$registry,'--registry-sha256','f8f3ee9711689993b5a9d663961c72b70b1b1dc7c13dd0252d7ec5e2fe5a2d9a','--binding',$binding,'worker')
 $e={param($v)[Security.SecurityElement]::Escape($v)};$sid=&$e $node.expected_sid;$exe=&$e $node.pythonw;$arguments=&$e $args;$working=&$e (Split-Path -Parent $script);$time=&$e $start
 $expected='<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task" version="1.4"><Triggers><TimeTrigger><Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>'+ $time +'</StartBoundary><Enabled>true</Enabled></TimeTrigger><LogonTrigger><Enabled>true</Enabled><UserId>'+ $sid +'</UserId></LogonTrigger></Triggers><Principals><Principal id="LocalCacheOwner"><UserId>'+ $sid +'</UserId><LogonType>S4U</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="LocalCacheOwner"><Exec><Command>'+ $exe +'</Command><Arguments>'+ $arguments +'</Arguments><WorkingDirectory>'+ $working +'</WorkingDirectory></Exec></Actions></Task>'
 $expectedDoc=[Xml.XmlDocument]::new();$expectedDoc.XmlResolver=$null;$expectedDoc.LoadXml($expected)
 Require ($doc.DocumentElement.OuterXml -ceq $expectedDoc.DocumentElement.OuterXml) 'XML_SOURCE_TEMPLATE_MISMATCH'
}
