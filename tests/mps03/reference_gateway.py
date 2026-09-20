#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, os, sqlite3, threading
from http.server import ThreadingHTTPServer

try:
    from mps03.common import ProtocolError, canonical_json, new_id, now_ns, sha256_json, validate_create_content, normalize_request_id
    from mps03.gateway_http import Handler
except ImportError:
    from common import ProtocolError, canonical_json, new_id, now_ns, sha256_json, validate_create_content, normalize_request_id
    from gateway_http import Handler

SCHEMA = r'''
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, principal TEXT NOT NULL, entry_kind TEXT NOT NULL, created_ns INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS objects(
  object_id TEXT PRIMARY KEY, title TEXT NOT NULL,
  current_revision_id TEXT NOT NULL, current_adoption_id TEXT NOT NULL,
  workflow_instance_id TEXT NOT NULL, workflow_instance_version INTEGER NOT NULL,
  workflow_binding_id TEXT NOT NULL, authorization_generation INTEGER NOT NULL,
  context_compilation_generation INTEGER NOT NULL, created_ns INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS revisions(
  revision_id TEXT PRIMARY KEY, object_id TEXT NOT NULL REFERENCES objects(object_id) DEFERRABLE INITIALLY DEFERRED,
  body_json TEXT NOT NULL, revision_digest TEXT NOT NULL, created_by TEXT NOT NULL, created_ns INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS adoptions(
  adoption_id TEXT PRIMARY KEY, object_id TEXT NOT NULL,
  revision_id TEXT NOT NULL, proposal_id TEXT, scope TEXT NOT NULL, purpose TEXT NOT NULL,
  created_by TEXT NOT NULL, created_ns INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS proposals(
  proposal_id TEXT PRIMARY KEY, object_id TEXT NOT NULL, base_revision_id TEXT NOT NULL,
  base_adoption_id TEXT NOT NULL, state_stamp_digest TEXT NOT NULL,
  proposed_body_json TEXT NOT NULL, proposal_digest TEXT NOT NULL,
  created_by TEXT NOT NULL, status TEXT NOT NULL, created_ns INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS request_results(
  request_id TEXT PRIMARY KEY, request_fingerprint TEXT NOT NULL,
  receipt_id TEXT NOT NULL, outcome_json TEXT NOT NULL, created_ns INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS receipts(
  receipt_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, request_fingerprint TEXT NOT NULL,
  object_id TEXT NOT NULL, proposal_id TEXT, result_revision_id TEXT,
  result_adoption_id TEXT, outcome_digest TEXT NOT NULL, outcome_json TEXT NOT NULL, created_ns INTEGER NOT NULL
);
'''

class CanonicalStore:
    backend_name = "TEST_ONLY_SQLITE_REFERENCE"
    def __init__(self, db_path: str, native_secret: str, agent_secret: str):
        self.db_path = db_path
        self.native_secret = native_secret
        self.agent_secret = agent_secret
        self._lock = threading.RLock()
        conn = self._connect()
        try:
            conn.executescript(SCHEMA)
            conn.commit()
        finally:
            conn.close()

    def _connect(self):
        conn = sqlite3.connect(self.db_path, timeout=30, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def create_session(self, entry_kind: str, entry_secret: str) -> dict:
        mapping = {
            "NATIVE": (self.native_secret, "native-user"),
            "THIRD_PARTY_AGENT_HOST": (self.agent_secret, "agent-host"),
        }
        if entry_kind not in mapping:
            raise ProtocolError("ENTRY_KIND_REJECTED", "unsupported entry kind", 403)
        expected, principal = mapping[entry_kind]
        if not entry_secret or entry_secret != expected:
            raise ProtocolError("ENTRY_AUTHENTICATION_FAILED", "entry credential rejected", 401)
        token = new_id("sess")
        with self._connect() as c:
            c.execute("INSERT INTO sessions VALUES(?,?,?,?)", (token, principal, entry_kind, now_ns()))
        return {"ok": True, "session_token": token, "principal": principal, "entry_kind": entry_kind}

    def _session(self, c, token: str) -> sqlite3.Row:
        row = c.execute("SELECT * FROM sessions WHERE token=?", (token,)).fetchone()
        if not row:
            raise ProtocolError("SESSION_REQUIRED", "valid session token required", 401)
        return row

    @staticmethod
    def _can(session, action: str) -> bool:
        principal = session["principal"]
        return action in ({"read", "create", "confirm", "history"} if principal == "native-user" else {"read", "propose", "history"})

    def _require(self, session, action: str):
        if not self._can(session, action):
            raise ProtocolError("ACTION_NOT_AUTHORIZED", f"{session['principal']} cannot {action}", 403)

    @staticmethod
    def _stamp(row: sqlite3.Row) -> dict:
        stamp = {
            "object_id": row["object_id"],
            "current_adoption_id": row["current_adoption_id"],
            "current_revision_id": row["current_revision_id"],
            "workflow_instance_id": row["workflow_instance_id"],
            "workflow_instance_version": row["workflow_instance_version"],
            "workflow_binding_id": row["workflow_binding_id"],
            "authorization_generation": row["authorization_generation"],
            "context_compilation_generation": row["context_compilation_generation"],
        }
        stamp["state_stamp_digest"] = sha256_json(stamp)
        return stamp

    def create_object(self, token: str, title: str, body: dict, request_id: str) -> dict:
        request_id=normalize_request_id(request_id)
        content=validate_create_content(title,body)
        payload = {"op": "create_object", "content": content}
        fp = sha256_json(payload)
        with self._lock, self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            s = self._session(c, token); self._require(s, "create")
            replay = self._replay(c, request_id, fp)
            if replay is not None:
                c.execute("COMMIT"); return replay
            oid, rid, aid, receipt = new_id("obj"), new_id("rv"), new_id("ad"), new_id("rc")
            t = now_ns(); body_json = canonical_json(body); rd = sha256_json(body)
            c.execute("INSERT INTO objects VALUES(?,?,?,?,?,?,?,?,?,?)",
                      (oid,title,rid,aid,"wf_personal_simple",1,"bind_personal_simple",1,1,t))
            c.execute("INSERT INTO revisions VALUES(?,?,?,?,?,?)", (rid,oid,body_json,rd,s['principal'],t))
            c.execute("INSERT INTO adoptions VALUES(?,?,?,?,?,?,?,?)", (aid,oid,rid,None,"object","create",s['principal'],t))
            obj = c.execute("SELECT * FROM objects WHERE object_id=?", (oid,)).fetchone()
            outcome = {"ok":True,"object_id":oid,"title":title,"revision_id":rid,"revision_digest":rd,
                       "adoption_id":aid,"body":body,"state_stamp":self._stamp(obj),"receipt_id":receipt}
            self._persist_result(c, request_id, fp, receipt, oid, None, rid, aid, outcome)
            c.execute("COMMIT"); return outcome

    def read_object(self, token: str, object_id: str) -> dict:
        with self._connect() as c:
            s=self._session(c,token); self._require(s,"read")
            obj=c.execute("SELECT * FROM objects WHERE object_id=?",(object_id,)).fetchone()
            if not obj: raise ProtocolError("OBJECT_NOT_FOUND","object not found",404)
            rev=c.execute("SELECT * FROM revisions WHERE revision_id=?",(obj['current_revision_id'],)).fetchone()
            return {"ok":True,"object_id":object_id,"title":obj['title'],"revision_id":rev['revision_id'],
                    "revision_digest":rev['revision_digest'],"adoption_id":obj['current_adoption_id'],
                    "body":json.loads(rev['body_json']),"state_stamp":self._stamp(obj)}

    def list_objects(self, token: str) -> dict:
        with self._connect() as c:
            s=self._session(c,token); self._require(s,"read")
            rows=c.execute("SELECT * FROM objects ORDER BY created_ns").fetchall()
            return {"ok":True,"objects":[{"object_id":r['object_id'],"title":r['title'],"revision_id":r['current_revision_id'],"adoption_id":r['current_adoption_id']} for r in rows]}

    def create_proposal(self, token: str, object_id: str, proposed_body: dict, observed_state_stamp: dict) -> dict:
        with self._lock, self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            s=self._session(c,token); self._require(s,"propose")
            obj=c.execute("SELECT * FROM objects WHERE object_id=?",(object_id,)).fetchone()
            if not obj: raise ProtocolError("OBJECT_NOT_FOUND","object not found",404)
            current_stamp=self._stamp(obj)
            if observed_state_stamp != current_stamp:
                raise ProtocolError("STALE_CONTEXT_REQUIRES_REFRESH","observed state is stale",409,{"current_state_stamp":current_stamp})
            pid=new_id("prop"); pd=sha256_json(proposed_body); t=now_ns()
            c.execute("INSERT INTO proposals VALUES(?,?,?,?,?,?,?,?,?,?)",
                      (pid,object_id,obj['current_revision_id'],obj['current_adoption_id'],current_stamp['state_stamp_digest'],canonical_json(proposed_body),pd,s['principal'],'OPEN',t))
            c.execute("COMMIT")
            return {"ok":True,"proposal_id":pid,"object_id":object_id,"proposal_digest":pd,
                    "base_revision_id":obj['current_revision_id'],"base_adoption_id":obj['current_adoption_id'],
                    "state_stamp_digest":current_stamp['state_stamp_digest'],"proposed_body":proposed_body}

    def list_proposals(self, token: str, object_id: str) -> dict:
        with self._connect() as c:
            s=self._session(c,token); self._require(s,"read")
            rows=c.execute("SELECT * FROM proposals WHERE object_id=? ORDER BY created_ns",(object_id,)).fetchall()
            return {"ok":True,"proposals":[{"proposal_id":r['proposal_id'],"status":r['status'],"proposal_digest":r['proposal_digest'],"proposed_body":json.loads(r['proposed_body_json']),"base_revision_id":r['base_revision_id'],"base_adoption_id":r['base_adoption_id'],"state_stamp_digest":r['state_stamp_digest']} for r in rows]}

    def confirm_proposal(self, token: str, object_id: str, proposal_id: str, state_stamp: dict, request_id: str,
                         adoption_scope: str="object", adoption_purpose: str="mps03_accept_agent_proposal") -> dict:
        request_id=normalize_request_id(request_id)
        if adoption_scope!="object" or adoption_purpose!="mps03_accept_agent_proposal":
            raise ProtocolError("CONFIRMATION_SCOPE_IMMUTABLE","confirmation scope and purpose are fixed by the proposal",400)
        payload={"op":"confirm_proposal","object_id":object_id,"proposal_id":proposal_id,
                 "state_stamp_digest":state_stamp.get("state_stamp_digest"),"adoption_scope":adoption_scope,"adoption_purpose":adoption_purpose}
        fp=sha256_json(payload)
        with self._lock, self._connect() as c:
            c.execute("BEGIN IMMEDIATE")
            s=self._session(c,token); self._require(s,"confirm")
            replay=self._replay(c,request_id,fp)
            if replay is not None:
                c.execute("COMMIT"); return replay
            obj=c.execute("SELECT * FROM objects WHERE object_id=?",(object_id,)).fetchone()
            if not obj: raise ProtocolError("OBJECT_NOT_FOUND","object not found",404)
            prop=c.execute("SELECT * FROM proposals WHERE proposal_id=? AND object_id=?",(proposal_id,object_id)).fetchone()
            if not prop: raise ProtocolError("PROPOSAL_NOT_FOUND","proposal not found",404)
            if prop['status'] != 'OPEN': raise ProtocolError("CONFIRMATION_TARGET_CHANGED","proposal is not open",409)
            current_stamp=self._stamp(obj)
            if state_stamp.get("state_stamp_digest") != current_stamp['state_stamp_digest'] or prop['state_stamp_digest'] != current_stamp['state_stamp_digest']:
                raise ProtocolError("STALE_CONTEXT_REQUIRES_REFRESH","Current changed since review",409,{"current_state_stamp":current_stamp})
            rid,aid,receipt=new_id("rv"),new_id("ad"),new_id("rc"); t=now_ns(); body=json.loads(prop['proposed_body_json']); rd=sha256_json(body)
            c.execute("INSERT INTO revisions VALUES(?,?,?,?,?,?)",(rid,object_id,prop['proposed_body_json'],rd,s['principal'],t))
            c.execute("INSERT INTO adoptions VALUES(?,?,?,?,?,?,?,?)",(aid,object_id,rid,proposal_id,adoption_scope,adoption_purpose,s['principal'],t))
            c.execute("UPDATE objects SET current_revision_id=?, current_adoption_id=?, context_compilation_generation=context_compilation_generation+1 WHERE object_id=?",(rid,aid,object_id))
            c.execute("UPDATE proposals SET status='ADOPTED' WHERE proposal_id=?",(proposal_id,))
            obj2=c.execute("SELECT * FROM objects WHERE object_id=?",(object_id,)).fetchone()
            outcome={"ok":True,"object_id":object_id,"proposal_id":proposal_id,"revision_id":rid,"revision_digest":rd,
                     "adoption_id":aid,"receipt_id":receipt,"body":body,"state_stamp":self._stamp(obj2)}
            self._persist_result(c,request_id,fp,receipt,object_id,proposal_id,rid,aid,outcome)
            c.execute("COMMIT"); return outcome

    def history(self, token: str, object_id: str) -> dict:
        with self._connect() as c:
            s=self._session(c,token); self._require(s,"history")
            rows=c.execute("SELECT a.*, r.revision_digest, r.body_json FROM adoptions a JOIN revisions r ON r.revision_id=a.revision_id WHERE a.object_id=? ORDER BY a.created_ns",(object_id,)).fetchall()
            return {"ok":True,"history":[{"adoption_id":r['adoption_id'],"revision_id":r['revision_id'],"revision_digest":r['revision_digest'],"proposal_id":r['proposal_id'],"scope":r['scope'],"purpose":r['purpose'],"body":json.loads(r['body_json']),"created_by":r['created_by']} for r in rows]}

    def _replay(self,c,request_id,fp):
        row=c.execute("SELECT * FROM request_results WHERE request_id=?",(request_id,)).fetchone()
        if not row: return None
        if row['request_fingerprint'] != fp:
            raise ProtocolError("IDEMPOTENCY_CONFLICT","same request_id used with different payload",409)
        return json.loads(row['outcome_json'])

    def _persist_result(self,c,request_id,fp,receipt,object_id,proposal_id,rid,aid,outcome):
        outcome_json=canonical_json(outcome); digest=sha256_json(outcome); t=now_ns()
        c.execute("INSERT INTO request_results VALUES(?,?,?,?,?)",(request_id,fp,receipt,outcome_json,t))
        c.execute("INSERT INTO receipts VALUES(?,?,?,?,?,?,?,?,?,?)",(receipt,request_id,fp,object_id,proposal_id,rid,aid,digest,outcome_json,t))



def main(argv=None):
    ap=argparse.ArgumentParser()
    ap.add_argument("--db",required=True)
    ap.add_argument("--host",default="127.0.0.1")
    ap.add_argument("--port",type=int,required=True)
    args=ap.parse_args(argv)
    native_secret=os.environ.get("MPS03_NATIVE_ENTRY_SECRET","")
    agent_secret=os.environ.get("MPS03_AGENT_ENTRY_SECRET","")
    if not native_secret or not agent_secret: raise RuntimeError("test gateway entry secrets required")
    Handler.store=CanonicalStore(args.db,native_secret,agent_secret)
    srv=ThreadingHTTPServer((args.host,args.port),Handler)
    print(json.dumps({"ready":True,"backend":"TEST_ONLY_SQLITE_REFERENCE","host":args.host,"port":args.port,"db":args.db,"formal_pass_claimed":False}),flush=True)
    try: srv.serve_forever()
    except KeyboardInterrupt: pass
    finally: srv.server_close()

if __name__=="__main__": main()
