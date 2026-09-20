//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWindowsDirectoryComesFromOSAPI(t *testing.T) {
	sys := realPlatform{}
	wd, e := sys.windowsDirectory()
	if e != nil { t.Fatal(e) }
	if !filepath.IsAbs(wd) || filepath.VolumeName(wd)=="" { t.Fatalf("wd=%q",wd) }
	t.Setenv("SystemRoot", `C:\attacker`)
	t.Setenv("WINDIR", `C:\attacker2`)
	wd2, e := sys.windowsDirectory()
	if e != nil { t.Fatal(e) }
	if !samePath(wd,wd2) || strings.Contains(strings.ToLower(wd2),"attacker") { t.Fatalf("%q -> %q",wd,wd2) }
}

func TestWindowsLaunchEnvelopeRejectsPollutionAndOverrides(t *testing.T) {
	sys:=realPlatform{}
	wd,e:=sys.windowsDirectory(); if e!=nil { t.Fatal(e) }
	env:=[]string{"SystemRoot="+wd,"WINDIR="+wd,"TEMP="+tempRoot,"TMP="+tempRoot}
	slot:=slotRootFor(productionLayout,revisionA)
	base:=serverLaunch(slot,env)
	if e=validateLaunchEnvelope(sys,base); e!=nil { t.Fatalf("base: %v",e) }

	polluted:=base
	polluted.env=append(append([]string{},base.env...),"PATH=C:\\attacker")
	if e=validateLaunchEnvelope(sys,polluted); codeOf(e)!="UNAUTHORIZED_LAUNCH_ENVELOPE_OVERRIDE_OR_DYNAMIC_INJECTION" { t.Fatalf("PATH: %v",e) }

	badEnv:=base
	badEnv.env=append([]string{},base.env...)
	badEnv.env[2]="TEMP=C:\\attacker"
	if e=validateLaunchEnvelope(sys,badEnv); codeOf(e)!="PATH_DLL_RUNTIME_SEARCH_OR_BACKEND_DEVICE_ENVIRONMENT_INFLUENCE_DETECTED" { t.Fatalf("TEMP: %v",e) }

	badArg:=base
	badArg.argv=append([]string{},base.argv...)
	badArg.argv[7]="18089"
	if e=validateLaunchEnvelope(sys,badArg); codeOf(e)!="EXECUTABLE_ARGV_ENDPOINT_OR_PROCESS_OWNERSHIP_DRIFT" { t.Fatalf("port: %v",e) }

	badCWD:=base
	badCWD.cwd=filepath.Join(slot,"payload","runtime")
	if e=validateLaunchEnvelope(sys,badCWD); e==nil { t.Fatal("CWD override accepted") }
}

func TestWindowsAtomicCurrentPublishInitialAndReplace(t *testing.T) {
	sys:=realPlatform{}
	dir:=t.TempDir()
	dst:=filepath.Join(dir,"current.json")
	temp1:=filepath.Join(dir,"current.transition-1.tmp")
	if e:=os.WriteFile(temp1,[]byte("A"),0600); e!=nil { t.Fatal(e) }
	if e:=sys.atomicPublish(temp1,dst,false); e!=nil { t.Fatal(e) }
	if raw,e:=os.ReadFile(dst); e!=nil || string(raw)!="A" { t.Fatalf("%q %v",raw,e) }
	if _,e:=os.Stat(temp1); !os.IsNotExist(e) { t.Fatalf("initial temp remains: %v",e) }

	temp2:=filepath.Join(dir,"current.transition-2.tmp")
	if e:=os.WriteFile(temp2,[]byte("B"),0600); e!=nil { t.Fatal(e) }
	if e:=sys.atomicPublish(temp2,dst,true); e!=nil { t.Fatal(e) }
	if raw,e:=os.ReadFile(dst); e!=nil || string(raw)!="B" { t.Fatalf("%q %v",raw,e) }
	if _,e:=os.Stat(temp2); !os.IsNotExist(e) { t.Fatalf("replace temp remains: %v",e) }

	temp3:=filepath.Join(dir,"current.transition-3.tmp")
	if e:=os.WriteFile(temp3,[]byte("C"),0600); e!=nil { t.Fatal(e) }
	if e:=sys.atomicPublish(temp3,dst,false); e==nil { t.Fatal("initial publish overwrote existing destination") }
	if raw,_:=os.ReadFile(dst); string(raw)!="B" { t.Fatalf("existing current changed: %q",raw) }
}

func TestWindowsNamedADSIsEnumeratedAndRejected(t *testing.T) {
	sys:=realPlatform{}
	dir:=t.TempDir()
	p:=filepath.Join(dir,"payload.bin")
	if e:=os.WriteFile(p,[]byte("payload"),0600); e!=nil { t.Fatal(e) }
	streams,e:=sys.namedStreams(p); if e!=nil { t.Fatal(e) }
	if len(streams)!=1 || !strings.EqualFold(streams[0],"::$DATA") { t.Fatalf("base streams=%#v",streams) }

	ads:=p+":Zone.Identifier"
	if e=os.WriteFile(ads,[]byte("[ZoneTransfer]"),0600); e!=nil { t.Skipf("ADS unavailable: %v",e) }
	streams,e=sys.namedStreams(p); if e!=nil { t.Fatal(e) }
	found:=false
	for _,s:=range streams { if strings.Contains(strings.ToLower(s),"zone.identifier") { found=true } }
	if !found { t.Fatalf("named ADS not enumerated: %#v",streams) }
	c:=newController(sys,admission{},layout{})
	if e=c.verifyNoNamedStreams(p); codeOf(e)!="NAMED_NTFS_ALTERNATE_DATA_STREAM_DETECTED_ON_BOUND_SOURCE_OR_SLOT_FILE" { t.Fatalf("ADS accepted: %v",e) }
}

func TestWindowsHardlinkCountDetectsAliasing(t *testing.T) {
	sys:=realPlatform{}
	dir:=t.TempDir()
	p:=filepath.Join(dir,"a.bin")
	q:=filepath.Join(dir,"b.bin")
	if e:=os.WriteFile(p,[]byte("x"),0600); e!=nil { t.Fatal(e) }
	n,e:=sys.hardlinkCount(p); if e!=nil || n!=1 { t.Fatalf("before=%d %v",n,e) }
	if e=os.Link(p,q); e!=nil { t.Skipf("hardlink unavailable: %v",e) }
	n,e=sys.hardlinkCount(p); if e!=nil || n<2 { t.Fatalf("after=%d %v",n,e) }
}

func TestWindowsReparsePointDetection(t *testing.T) {
	sys:=realPlatform{}
	dir:=t.TempDir()
	target:=filepath.Join(dir,"target")
	link:=filepath.Join(dir,"link")
	if e:=os.Mkdir(target,0700); e!=nil { t.Fatal(e) }
	if e:=os.Symlink(target,link); e!=nil { t.Skipf("symlink unavailable without developer mode/privilege: %v",e) }
	rp,e:=sys.pathIsReparse(link); if e!=nil { t.Fatal(e) }
	if !rp { t.Fatal("symlink was not reported as reparse point") }
}


func TestWindowsFinalPathAndDirectoryIdentity(t *testing.T) {
	sys:=realPlatform{}
	dir:=t.TempDir()
	final,e:=sys.finalPath(dir)
	if e!=nil { t.Fatal(e) }
	if !samePath(final,dir) { t.Fatalf("final=%q dir=%q",final,dir) }
	id,e:=sys.directoryIdentity(dir)
	if e!=nil { t.Fatal(e) }
	if !samePath(id.canonicalPath,dir) ||
		!strings.EqualFold(id.filesystemType,"NTFS") ||
		len(id.volumeSerial)!=8 || len(id.fileID)!=16 ||
		!strings.HasPrefix(strings.ToUpper(id.ownerSID),"S-") ||
		len(id.securityDescriptorSHA256)!=64 {
		t.Fatalf("identity=%#v",id)
	}
}
