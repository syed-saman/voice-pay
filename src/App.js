import { useState, useRef, useCallback } from "react";

// ─── Platform detection ────────────────────────────────────────────────────
const IS_IOS     = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const IS_ANDROID = /Android/.test(navigator.userAgent);
const HAS_SPEECH = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

// ─── Contacts persistence ──────────────────────────────────────────────────
function loadContacts() {
  try { const s = localStorage.getItem("vp_contacts"); return s ? JSON.parse(s) : []; }
  catch { return []; }
}
function saveContacts(c) { localStorage.setItem("vp_contacts", JSON.stringify(c)); }

// ─── UPI VPA candidates ───────────────────────────────────────────────────
function buildVpaCandidates(contact) {
  const phone = contact.phone?.replace(/\D/g, "").slice(-10);
  const explicit = contact.upi?.trim();
  const candidates = [];
  if (explicit?.includes("@")) candidates.push(explicit);
  if (phone) candidates.push(
    `${phone}@ybl`, `${phone}@okicici`, `${phone}@okaxis`,
    `${phone}@paytm`, `${phone}@upi`, `${phone}@sbi`,
  );
  return [...new Set(candidates)];
}
function primaryVpa(contact) {
  return buildVpaCandidates(contact)[0] || contact.upi || "unknown@upi";
}

// ─── UPI app launcher — no confirmation popup on either platform ───────────
// Android: hidden <a> on upi:// → Android intent chooser (no Chrome "allow" popup)
// iOS: app-specific scheme for whichever app the user chose in Settings
const UPI_APPS = [
  { id: "phonepe", label: "PhonePe",    scheme: p => `phonepe://pay?${p}`,   color: "#5F259F" },
  { id: "gpay",    label: "Google Pay", scheme: p => `tez://upi/pay?${p}`,   color: "#1A73E8" },
  { id: "paytm",   label: "Paytm",     scheme: p => `paytmmp://pay?${p}`,   color: "#002970" },
  { id: "bhim",    label: "BHIM",       scheme: p => `upi://pay?${p}`,       color: "#FF6600" },
];

function launchUpiApp(params, preferredAppId = "phonepe") {
  if (IS_ANDROID) {
    // Hidden anchor = native Android intent chooser, zero Chrome popup
    const a = document.createElement("a");
    a.href = `upi://pay?${params}`;
    a.rel  = "noopener noreferrer";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 500);
    return;
  }
  // iOS / desktop: use app-specific scheme
  const app = UPI_APPS.find(a => a.id === preferredAppId) || UPI_APPS[0];
  window.location.href = app.scheme(params);
}

// ─── Contact Picker API (Android Chrome only) ─────────────────────────────
const HAS_CONTACT_PICKER = "contacts" in navigator && "ContactsManager" in window;

async function pickPhoneContacts() {
  if (!HAS_CONTACT_PICKER) return null;
  const props = await navigator.contacts.getProperties();
  if (!props.includes("name") || !props.includes("tel")) return null;
  return navigator.contacts.select(["name", "tel"], { multiple: true });
}

function phoneContactsToLocal(raw) {
  return raw.flatMap(rc => {
    const name = (rc.name || [])[0]?.trim();
    const tel  = (rc.tel  || [])[0]?.replace(/[\s\-().+ ]/g, "").slice(-10);
    if (!name || !tel) return [];
    return [{ name, phone: tel, upi: `${tel}@ybl`, avatar: name[0].toUpperCase(), aliases: [] }];
  });
}

// ─── Intent parser ────────────────────────────────────────────────────────
function norm(s) { return (s || "").toLowerCase().replace(/[^\w\u0900-\u097F ]/g, "").trim(); }

function lev(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({length:m+1},(_,i)=>Array.from({length:n+1},(_,j)=>i||j));
  for (let i=1;i<=m;i++) for (let j=1;j<=n;j++)
    dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]:1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return dp[m][n];
}

function latinToDevanagari(name) {
  const map=[
    [/sh/gi,"श"],[/kh/gi,"ख"],[/gh/gi,"घ"],[/ch/gi,"च"],[/ph/gi,"फ"],
    [/th/gi,"थ"],[/dh/gi,"ध"],[/bh/gi,"भ"],[/aa/gi,"ा"],[/ee/gi,"ी"],
    [/oo/gi,"ू"],[/ai/gi,"ै"],[/au/gi,"ो"],[/a/gi,"ा"],[/i/gi,"ि"],
    [/u/gi,"ु"],[/e/gi,"े"],[/o/gi,"ो"],[/k/gi,"क"],[/g/gi,"ग"],
    [/c/gi,"क"],[/j/gi,"ज"],[/t/gi,"त"],[/d/gi,"द"],[/n/gi,"न"],
    [/p/gi,"प"],[/b/gi,"ब"],[/m/gi,"म"],[/y/gi,"य"],[/r/gi,"र"],
    [/l/gi,"ल"],[/v/gi,"व"],[/w/gi,"व"],[/s/gi,"स"],[/h/gi,"ह"],
    [/f/gi,"फ"],[/z/gi,"ज"],
  ];
  let r=name; for(const [f,t] of map) r=r.replace(f,t); return r;
}

function scoreContact(token, contact) {
  if (token.length < 2) return 0;
  const t = norm(token);
  const nameParts = norm(contact.name).split(/\s+/);
  const candidates = [
    ...nameParts, norm(contact.name),
    ...(contact.aliases||[]).map(a=>norm(a)),
    norm(latinToDevanagari(contact.name)),
  ];
  let best=0;
  for (const c of candidates) {
    if (!c||c.length<2) continue;
    if (c===t)                                { best=1; break; }
    if (c.startsWith(t)||t.startsWith(c))     best=Math.max(best,.9);
    if (c.includes(t)||t.includes(c))         best=Math.max(best,.75);
    if (t.length>=4&&c.length>=4) {
      const d=lev(t,c);
      if (d<=1) best=Math.max(best,.85);
      else if (d<=2) best=Math.max(best,.6);
    }
  }
  return best;
}

function parseIntent(text, contacts) {
  const t = text.toLowerCase().trim();

  const numWords = {
    "ek rupaya":1,"ek rupaye":1,"one rupee":1,
    "do hazaar":2000,"teen hazaar":3000,"char hazaar":4000,"paanch hazaar":5000,"das hazaar":10000,
    "दो हजार":2000,"तीन हजार":3000,"पाँच हजार":5000,
    "ek sau":100,"do sau":200,"teen sau":300,"char sau":400,"panch sau":500,"paanch sau":500,
    "two hundred":200,"three hundred":300,"four hundred":400,"five hundred":500,
    "दो सौ":200,"तीन सौ":300,"पाँच सौ":500,"पांच सौ":500,
    "twenty five":25,"पच्चीस":25,"pachees":25,
    "pachaas":50,"पचास":50,"fifty":50,"bees":20,"bis":20,"twenty":20,"बीस":20,
    "tees":30,"thirty":30,"तीस":30,"chalees":40,"forty":40,"चालीस":40,
    "sau":100,"सौ":100,"hundred":100,
    "hazaar":1000,"hazar":1000,"hajar":1000,"हज़ार":1000,"हजार":1000,"thousand":1000,
    "das":10,"ten":10,"nau":9,"aath":8,"saat":7,"sat":7,"chhe":6,
    "paanch":5,"panch":5,"char":4,"teen":3,"tin":3,"do":2,"ek":1,
  };
  let amount=null;
  for (const [word,val] of Object.entries(numWords).sort((a,b)=>b[0].length-a[0].length)) {
    if (t.includes(word)) { amount=val; break; }
  }
  if (!amount) {
    // Match Western digits (50, 500) and Devanagari digits (५०, ५००)
    const devanagariToWestern = s => s.replace(/[०-९]/g, d => d.charCodeAt(0) - 0x0966);
    const normalised = devanagariToWestern(t);
    const m = normalised.match(/\b(\d+(?:\.\d+)?)\b/);
    if (m) amount = parseFloat(m[1]);
  }

  const tokens=text.split(/\s+/);
  let matchedContact=null, bestScore=0;
  for (const contact of contacts) {
    for (const token of tokens) {
      const s=scoreContact(token,contact);
      if(s>bestScore){bestScore=s;matchedContact=contact;}
    }
    for (let i=0;i<tokens.length-1;i++) {
      const s=scoreContact(tokens[i]+" "+tokens[i+1],contact);
      if(s>bestScore){bestScore=s;matchedContact=contact;}
    }
  }
  if (bestScore<0.5) matchedContact=null;

  const skipWords=new Set(["sau","hazaar","rupaye","rupaya","rupee","bhejo","bhej","ko","karo","send","pay","do","das"]);
  if (!matchedContact) {
    const noun=tokens.find(w=>w.length>2&&/[a-zA-Z]/.test(w[0])&&w[0]===w[0].toUpperCase()&&!skipWords.has(w.toLowerCase()));
    if (noun) matchedContact={name:noun,upi:`${noun.toLowerCase()}@ybl`,avatar:noun[0].toUpperCase(),aliases:[]};
  }

  const noteKws=["chai","khana","petrol","bill","rent","kiraya","dinner","lunch","medicine","dawa","coffee","recharge","udhaar"];
  const noteMatch=t.match(/(?:ke liye|for|liye)\s+([a-zA-Z\u0900-\u097F]+)/i);
  const note=noteMatch?noteMatch[1]:(noteKws.find(k=>t.includes(k))||null);

  if (matchedContact&&amount) {
    return {intent:"SEND_PAYMENT",recipient:matchedContact.name,amount,note,contact:matchedContact,
      response_hindi:`${matchedContact.name} ko ${amount} rupaye bhej rahe hain`};
  }
  if (matchedContact&&!amount) return {intent:"UNKNOWN",error:`Kitne rupaye ${matchedContact.name} ko?`};
  if (amount&&!matchedContact)  return {intent:"UNKNOWN",error:`Kisko bhejun ${amount} rupaye?`};
  return {intent:"UNKNOWN",error:`Samjha nahi — bolein: "Rahul ko 50 rupaye"`};
}

// ─── Claude API parser ─────────────────────────────────────────────────────
async function parseWithClaude(text, contacts, apiKey) {
  const contactList=contacts.map(c=>`${c.name} (${primaryVpa(c)})`).join(", ");
  const res=await fetch("https://api.anthropic.com/v1/messages",{
    method:"POST",
    headers:{"x-api-key":apiKey,"anthropic-version":"2023-06-01","content-type":"application/json"},
    body:JSON.stringify({
      model:"claude-haiku-4-5-20251001",max_tokens:200,
      system:`UPI voice assistant. Extract payment from Hindi/Hinglish/English. Contacts: ${contactList||"none"}. JSON only: {"intent":"SEND_PAYMENT","recipient":"<name>","amount":<num>,"note":"<opt>","error":null} or {"intent":"UNKNOWN","error":"<hindi>"}`,
      messages:[{role:"user",content:text}],
    }),
  });
  if(!res.ok) throw new Error("Claude API "+res.status);
  const data=await res.json();
  const parsed=JSON.parse(data.content[0].text);
  if(parsed.intent==="SEND_PAYMENT"){
    const mc=contacts.find(c=>norm(c.name)===norm(parsed.recipient)||(c.aliases||[]).some(a=>norm(a)===norm(parsed.recipient)))
      ||{name:parsed.recipient,upi:`${norm(parsed.recipient||"")}@ybl`,avatar:(parsed.recipient||"?")[0].toUpperCase(),aliases:[]};
    return{...parsed,contact:mc,response_hindi:`${mc.name} ko ${parsed.amount} rupaye bhej rahe hain`};
  }
  return parsed;
}

// ─── Contacts screen ──────────────────────────────────────────────────────
function ContactsScreen({contacts,setContacts}) {
  const [form,setForm]=useState({name:"",phone:"",upi:"",aliases:""});
  const [formError,setFormError]=useState("");
  const [editIdx,setEditIdx]=useState(null);
  const [importing,setImporting]=useState(false);
  const [importMsg,setImportMsg]=useState("");

  const inp={width:"100%",background:"rgba(255,255,255,.05)",border:"1px solid rgba(255,255,255,.1)",color:"#F0EDE8",borderRadius:"10px",padding:"11px 14px",fontSize:"14px",boxSizing:"border-box",marginBottom:"10px"};

  const saveContact=()=>{
    setFormError("");
    if(!form.name.trim()){setFormError("Name required");return;}
    if(!form.phone.trim()&&!form.upi.trim()){setFormError("Enter phone OR UPI ID");return;}
    const phone=form.phone.replace(/\D/g,"").slice(-10);
    const upiId=form.upi.trim()||(phone?`${phone}@ybl`:"");
    const aliases=form.aliases.split(",").map(a=>a.trim()).filter(Boolean);
    const contact={name:form.name.trim(),phone:phone||null,upi:upiId,avatar:form.name.trim()[0].toUpperCase(),aliases};
    const updated=editIdx!==null?contacts.map((c,i)=>i===editIdx?contact:c):[...contacts,contact];
    setContacts(updated);saveContacts(updated);
    setForm({name:"",phone:"",upi:"",aliases:""});setEditIdx(null);
  };
  const deleteContact=(idx)=>{const u=contacts.filter((_,i)=>i!==idx);setContacts(u);saveContacts(u);};
  const editContact=(idx)=>{const c=contacts[idx];setForm({name:c.name,phone:c.phone||"",upi:c.upi,aliases:(c.aliases||[]).join(", ")});setEditIdx(idx);};

  const importFromPhone=async()=>{
    setImporting(true);setImportMsg("");
    try{
      const raw=await pickPhoneContacts();
      if(!raw){setImportMsg("Contact Picker only works on Android Chrome.");setImporting(false);return;}
      if(raw.length===0){setImportMsg("No contacts selected.");setImporting(false);return;}
      const newC=phoneContactsToLocal(raw);
      const existing=new Set(contacts.map(c=>c.phone).filter(Boolean));
      const toAdd=newC.filter(c=>!existing.has(c.phone));
      const merged=[...contacts,...toAdd];
      setContacts(merged);saveContacts(merged);
      setImportMsg(`✅ Imported ${toAdd.length} contact${toAdd.length!==1?"s":""}${raw.length-toAdd.length>0?` (${raw.length-toAdd.length} already saved)`:""}.`);
    }catch(e){
      setImportMsg(e.name==="AbortError"?"Cancelled.":"Error: "+e.message);
    }
    setImporting(false);
  };

  return(
    <div style={{width:"100%",maxWidth:"420px",animation:"fadeUp .3s ease"}}>
      {/* Import */}
      <div style={{background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,107,53,.15)",borderRadius:"18px",padding:"18px",marginBottom:"16px"}}>
        <div style={{fontSize:"10px",letterSpacing:"3px",color:"#FF6B35",marginBottom:"10px"}}>📲 IMPORT FROM PHONE</div>
        {IS_IOS
          ? <p style={{fontSize:"13px",color:"#555",lineHeight:"1.6",margin:0}}>
              Contact import requires Android Chrome. On iPhone, use <strong style={{color:"#888"}}>Add Manually</strong> below.
            </p>
          : <>
            <p style={{fontSize:"13px",color:"#555",lineHeight:"1.6",marginBottom:"12px"}}>
              Pick directly from your phone's address book. Works once, saves locally.
            </p>
            <button onClick={importFromPhone} disabled={importing||!HAS_CONTACT_PICKER}
              style={{width:"100%",background:HAS_CONTACT_PICKER?"linear-gradient(135deg,rgba(255,107,53,.2),rgba(247,147,30,.15))":"rgba(255,255,255,.04)",border:"1px solid rgba(255,107,53,.3)",color:HAS_CONTACT_PICKER?"#FF6B35":"#444",borderRadius:"10px",padding:"12px",fontSize:"14px",fontWeight:600,cursor:HAS_CONTACT_PICKER?"pointer":"not-allowed",opacity:importing?.7:1}}>
              {importing?"Opening contacts…":"📒 Pick Contacts from Phone"}
            </button>
            {importMsg&&<div style={{marginTop:"10px",fontSize:"13px",color:importMsg.startsWith("✅")?"#22C55E":"#EF4444"}}>{importMsg}</div>}
          </>
        }
      </div>

      {/* Manual */}
      <div style={{background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,107,53,.2)",borderRadius:"18px",padding:"18px",marginBottom:"20px"}}>
        <div style={{fontSize:"10px",letterSpacing:"3px",color:"#FF6B35",marginBottom:"16px"}}>
          {editIdx!==null?"EDIT CONTACT":"ADD MANUALLY"}
        </div>
        <input style={inp} placeholder="Name (e.g. Rahul Bhai)" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))}/>
        <input style={inp} placeholder="📱 Phone (10 digits)" value={form.phone} onChange={e=>setForm(f=>({...f,phone:e.target.value}))} inputMode="tel"/>
        <input style={inp} placeholder="UPI ID (e.g. 9876543210@okicici)" value={form.upi} onChange={e=>setForm(f=>({...f,upi:e.target.value}))}/>
        <input style={inp} placeholder="Nicknames if voice mishears (comma separated)" value={form.aliases} onChange={e=>setForm(f=>({...f,aliases:e.target.value}))}/>
        <div style={{fontSize:"11px",color:"#444",marginBottom:"14px",lineHeight:1.7}}>
          💡 Phone number is usually enough. App tries @ybl→@okicici→@okaxis→@paytm. Paste exact UPI ID to skip guessing.
        </div>
        {formError&&<div style={{color:"#EF4444",fontSize:"12px",marginBottom:"10px"}}>{formError}</div>}
        <div style={{display:"flex",gap:"8px"}}>
          {editIdx!==null&&<button onClick={()=>{setEditIdx(null);setForm({name:"",phone:"",upi:"",aliases:""}); }} style={{flex:1,background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.08)",color:"#666",borderRadius:"10px",padding:"12px",fontSize:"14px",cursor:"pointer"}}>Cancel</button>}
          <button onClick={saveContact} style={{flex:2,background:"linear-gradient(135deg,#FF6B35,#F7931E)",border:"none",color:"#fff",borderRadius:"10px",padding:"12px",fontSize:"14px",fontWeight:700,cursor:"pointer"}}>
            {editIdx!==null?"Save Changes":"Add Contact"}
          </button>
        </div>
      </div>

      {/* List */}
      {contacts.length===0
        ?<div style={{textAlign:"center",color:"#444",fontSize:"14px",padding:"30px"}}>No contacts yet. Add above ☝️</div>
        :<>
          <div style={{fontSize:"10px",color:"#333",letterSpacing:"3px",marginBottom:"10px"}}>SAVED ({contacts.length})</div>
          {contacts.map((c,i)=>(
            <div key={i} style={{background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,255,255,.07)",borderRadius:"18px",padding:"16px",marginBottom:"10px",display:"flex",alignItems:"center",gap:"14px"}}>
              <div style={{width:"44px",height:"44px",borderRadius:"50%",background:"linear-gradient(135deg,#1A1A2E,#2D2D4E)",border:"1px solid rgba(255,107,53,.2)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"18px",fontWeight:700,color:"#FF6B35",flexShrink:0}}>{c.avatar}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:"15px",fontWeight:600,marginBottom:"2px"}}>{c.name}</div>
                <div style={{fontSize:"11px",color:"#555",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>UPI: {primaryVpa(c)}</div>
                {c.phone&&<div style={{fontSize:"11px",color:"#444"}}>📱 {c.phone}</div>}
                {c.aliases?.length>0&&<div style={{fontSize:"11px",color:"#444",marginTop:"2px"}}>🗣 "{c.aliases.join('", "')}"</div>}
              </div>
              <div style={{display:"flex",gap:"6px",flexShrink:0}}>
                <button onClick={()=>editContact(i)} style={{background:"rgba(255,255,255,.05)",border:"none",color:"#666",borderRadius:"8px",padding:"6px 10px",cursor:"pointer"}}>✏️</button>
                <button onClick={()=>deleteContact(i)} style={{background:"rgba(239,68,68,.08)",border:"none",color:"#EF4444",borderRadius:"8px",padding:"6px 10px",cursor:"pointer"}}>🗑</button>
              </div>
            </div>
          ))}
        </>
      }
    </div>
  );
}

// ─── Settings screen ──────────────────────────────────────────────────────
function SettingsScreen({claudeKey,setClaudeKey,useClaudeParser,setUseClaudeParser,preferredApp,setPreferredApp}) {
  const [keyInput,setKeyInput]=useState(claudeKey);
  const inp={width:"100%",background:"rgba(255,255,255,.05)",border:"1px solid rgba(255,255,255,.1)",color:"#F0EDE8",borderRadius:"10px",padding:"11px 14px",fontSize:"14px",boxSizing:"border-box",marginBottom:"10px",fontFamily:"monospace"};
  const saveKey=()=>{
    localStorage.setItem("vp_claude_key",keyInput);
    setClaudeKey(keyInput);
    const active=!!keyInput;
    setUseClaudeParser(active);
    localStorage.setItem("vp_use_claude",active?"1":"0");
  };
  return(
    <div style={{width:"100%",maxWidth:"420px",animation:"fadeUp .3s ease"}}>

      {/* UPI App Picker — always shown, critical for iOS */}
      <div style={{background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,107,53,.2)",borderRadius:"18px",padding:"18px",marginBottom:"16px"}}>
        <div style={{fontSize:"10px",letterSpacing:"3px",color:"#FF6B35",marginBottom:"6px"}}>📱 YOUR UPI APP</div>
        <p style={{fontSize:"13px",color:"#555",lineHeight:"1.5",marginBottom:"14px"}}>
          {IS_IOS?"iOS needs to know which app to open — pick it once here."
                 :"On Android, all UPI apps appear automatically. You can still set a preferred one."}
        </p>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"8px"}}>
          {UPI_APPS.map(app=>(
            <button key={app.id} onClick={()=>{setPreferredApp(app.id);localStorage.setItem("vp_preferred_app",app.id);}}
              style={{padding:"12px 10px",borderRadius:"12px",border:`2px solid ${preferredApp===app.id?app.color:"rgba(255,255,255,.08)"}`,background:preferredApp===app.id?`${app.color}22`:"rgba(255,255,255,.03)",color:preferredApp===app.id?"#F0EDE8":"#555",fontSize:"13px",fontWeight:preferredApp===app.id?700:400,cursor:"pointer",transition:"all .2s"}}>
              {preferredApp===app.id?"✓ ":""}{app.label}
            </button>
          ))}
        </div>
        {IS_IOS&&<p style={{fontSize:"11px",color:"#444",marginTop:"10px",lineHeight:1.6}}>
          ⚠️ Make sure the selected app is installed on your iPhone. If payment doesn't open, try a different app above.
        </p>}
      </div>

      {/* Claude API */}
      <div style={{background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,255,255,.07)",borderRadius:"18px",padding:"18px",marginBottom:"16px"}}>
        <div style={{fontSize:"10px",letterSpacing:"3px",color:"#555",marginBottom:"12px"}}>🤖 CLAUDE AI PARSER (OPTIONAL)</div>
        <input style={inp} type="password" placeholder="sk-ant-... (Claude API key)" value={keyInput} onChange={e=>setKeyInput(e.target.value)}/>
        <div style={{display:"flex",alignItems:"center",gap:"10px",marginBottom:"14px"}}>
          <div onClick={()=>{const v=!useClaudeParser;setUseClaudeParser(v);localStorage.setItem("vp_use_claude",v?"1":"0");}}
            style={{width:"42px",height:"24px",borderRadius:"12px",background:useClaudeParser?"#FF6B35":"rgba(255,255,255,.1)",cursor:"pointer",position:"relative",transition:"background .2s",flexShrink:0}}>
            <div style={{position:"absolute",top:"3px",left:useClaudeParser?"21px":"3px",width:"18px",height:"18px",borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
          </div>
          <span style={{fontSize:"13px",color:useClaudeParser?"#FF6B35":"#555"}}>{useClaudeParser?"Claude AI active":"Local parser"}</span>
        </div>
        <button onClick={saveKey} style={{width:"100%",background:"linear-gradient(135deg,#FF6B35,#F7931E)",border:"none",color:"#fff",borderRadius:"10px",padding:"12px",fontSize:"14px",fontWeight:700,cursor:"pointer"}}>Save API Key</button>
      </div>

      {/* Install */}
      <div style={{background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,255,255,.07)",borderRadius:"18px",padding:"18px"}}>
        <div style={{fontSize:"10px",letterSpacing:"3px",color:"#555",marginBottom:"12px"}}>📲 INSTALL AS APP</div>
        <p style={{fontSize:"13px",color:"#555",lineHeight:"1.7",margin:0}}>
          {IS_IOS
            ?<><strong style={{color:"#888"}}>iPhone:</strong> Open this page in <strong style={{color:"#FF6B35"}}>Safari</strong> (not Chrome) → tap Share → "Add to Home Screen". Voice + UPI links work best from Safari on iOS.</>
            :<><strong style={{color:"#888"}}>Android Chrome:</strong> tap ⋮ → "Add to Home screen". Once installed as a standalone app, UPI launches without any browser popups.</>
          }
        </p>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────
export default function VoicePayment() {
  const [contacts,setContacts]=useState(loadContacts);
  const [phase,setPhase]=useState("idle");          // idle | listening | processing | paying | success | error
  const [screen,setScreen]=useState("pay");
  const [transcript,setTranscript]=useState("");
  const [lastPaid,setLastPaid]=useState(null);
  const [transactions,setTransactions]=useState(()=>{
    try{const s=localStorage.getItem("vp_txns");return s?JSON.parse(s):[];}catch{return[];}
  });
  const [errorMsg,setErrorMsg]=useState("");
  const [pulseRings,setPulseRings]=useState(false);
  const [claudeKey,setClaudeKey]=useState(()=>localStorage.getItem("vp_claude_key")||"");
  const [useClaudeParser,setUseClaudeParser]=useState(()=>localStorage.getItem("vp_use_claude")==="1");
  const [preferredApp,setPreferredApp]=useState(()=>localStorage.getItem("vp_preferred_app")||"phonepe");
  // Text input fallback (shown when speech unavailable or user prefers typing)
  const [textMode,setTextMode]=useState(!HAS_SPEECH);
  const [textInput,setTextInput]=useState("");

  const recognitionRef=useRef(null);

  const speak=useCallback((text)=>{
    window.speechSynthesis.cancel();
    const u=new SpeechSynthesisUtterance(text);
    u.lang="hi-IN";u.rate=0.9;u.pitch=1;
    const go=()=>{
      const voices=window.speechSynthesis.getVoices();
      u.voice=voices.find(v=>v.lang==="hi-IN")||voices.find(v=>v.lang.startsWith("hi"))||voices.find(v=>v.lang==="en-IN")||null;
      window.speechSynthesis.speak(u);
    };
    window.speechSynthesis.getVoices().length>0?go():(window.speechSynthesis.onvoiceschanged=go);
  },[]);

  const addTransaction=useCallback((txn)=>{
    setTransactions(prev=>{
      const updated=[txn,...prev].slice(0,50);
      localStorage.setItem("vp_txns",JSON.stringify(updated));
      return updated;
    });
  },[]);

  // ── Core: parse → pay immediately, NO confirmation step ─────────────────
  const parseAndPay=useCallback(async(text)=>{
    if(!text?.trim()){setPhase("idle");return;}
    setPhase("processing");
    try{
      let parsed;
      if(useClaudeParser&&claudeKey){
        try{parsed=await parseWithClaude(text,contacts,claudeKey);}
        catch(e){console.warn("Claude fallback:",e);parsed=parseIntent(text,contacts);}
      }else{
        await new Promise(r=>setTimeout(r,200)); // tiny delay so "processing" renders
        parsed=parseIntent(text,contacts);
      }

      if(parsed.intent==="SEND_PAYMENT"){
        const p=parsed;
        // Speak confirmation WHILE launching app — fully parallel, zero waiting
        speak(p.response_hindi);
        setPhase("paying");

        const txn={
          id:"TXN"+Math.floor(Math.random()*900000+100000),
          to:p.contact.name,upi:primaryVpa(p.contact),
          amount:p.amount,note:p.note,
          time:new Date().toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"}),
          date:new Date().toLocaleDateString("en-IN",{day:"2-digit",month:"short"}),
          avatar:p.contact.avatar||p.contact.name[0],
        };
        addTransaction(txn);
        setLastPaid(txn);

        const params=new URLSearchParams({
          pa:primaryVpa(p.contact),pn:p.contact.name,
          am:p.amount,cu:"INR",
          tn:p.note||"Voice payment",mc:"",tr:txn.id,
        }).toString();

        // Small delay so "paying…" renders before app switch
        setTimeout(()=>{
          setPhase("success");
          launchUpiApp(params,preferredApp);
        },300);

      }else{
        setPhase("error");
        setErrorMsg(parsed.error);
        speak(parsed.error);
      }
    }catch(e){
      setPhase("error");
      setErrorMsg("Parser error — try again.");
    }
  },[contacts,speak,addTransaction,useClaudeParser,claudeKey,preferredApp]);

  const reset=useCallback(()=>{
    setPhase("idle");setTranscript("");setErrorMsg("");setTextInput("");
  },[]);

  // ── Speech recognition — processes as soon as final result arrives ───────
  const startListening=useCallback(()=>{
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR){
      setTextMode(true);
      setErrorMsg("Voice not available in this browser. Use the text box below.");
      setPhase("error");
      return;
    }
    const r=new SR();
    // iOS Safari with hi-IN transcribes numbers as Devanagari words ("ये", "पचास")
    // which then fail amount parsing. en-IN on iOS keeps numbers as digits ("50", "100")
    // while still recognising Hindi names and Hinglish phrases perfectly.
    // Android hi-IN is fine — it code-switches and produces digits already.
    r.lang = IS_IOS ? "en-IN" : "hi-IN";
    r.interimResults=true;
    r.continuous=false;
    r.maxAlternatives=3;
    recognitionRef.current=r;

    let bestFinal="";
    let interimText="";
    let autoStop=null;
    let processingStarted=false;

    const doProcess=(text)=>{
      if(processingStarted||!text.trim()) return;
      processingStarted=true;
      clearTimeout(autoStop);
      try{r.abort();}catch(e){}
      parseAndPay(text);
    };

    r.onstart=()=>{
      setPhase("listening");setPulseRings(true);setTranscript("");setErrorMsg("");
      // Auto-stop after 7 s — if we have interim text, use it (handles "no-speech" situations)
      autoStop=setTimeout(()=>{
        if(interimText.trim()) doProcess(interimText);
        else { try{r.stop();}catch(e){} }
      },7000);
    };

    r.onresult=(e)=>{
      const results=Array.from(e.results);
      interimText=results.map(x=>x[0].transcript).join("");
      // Pick highest-confidence alternative for final results
      const finalText=results.filter(x=>x.isFinal).map(x=>{
        let best=x[0];
        for(let i=1;i<x.length;i++) if(x[i].confidence>best.confidence) best=x[i];
        return best.transcript;
      }).join("");
      if(finalText) bestFinal=finalText;

      // Update live display
      setTranscript(interimText);

      // As soon as we have a final result, check if we can parse already
      if(finalText&&e.results[e.results.length-1].isFinal){
        // Quick check: do we already have both a contact and an amount?
        const quick=parseIntent(bestFinal,contacts);
        if(quick.intent==="SEND_PAYMENT"){
          // We have enough — don't wait for more, go immediately
          doProcess(bestFinal);
        }
      }
    };

    r.onend=()=>{
      clearTimeout(autoStop);
      setPulseRings(false);
      // Use whatever we got — bestFinal if available, else interimText
      const text=bestFinal||interimText;
      doProcess(text);
    };

    r.onerror=(e)=>{
      clearTimeout(autoStop);
      setPulseRings(false);
      if(e.error==="no-speech"){
        // Don't show error for no-speech if we have interim text
        if(interimText.trim()){doProcess(interimText);return;}
        setPhase("idle"); // silently reset — user just didn't speak
        return;
      }
      if(e.error==="aborted") return; // we aborted intentionally
      processingStarted=true; // prevent double-process in onend
      setPhase("error");
      const msgs={
        "not-allowed":"Mic blocked — tap the 🔒 lock icon in your browser and allow microphone access.",
        "network":"Network error — check your connection.",
        "audio-capture":"No microphone found.",
      };
      setErrorMsg(msgs[e.error]||`Mic error: ${e.error}`);
    };

    r.start();
  },[contacts,parseAndPay]);

  const stopListening=useCallback(()=>{try{recognitionRef.current?.stop();}catch(e){}},[]);

  const tabs=[
    {id:"pay",      label:"🎙️ Pay"},
    {id:"contacts", label:`👥 Contacts${contacts.length?` (${contacts.length})`:""}`},
    {id:"history",  label:`📋 History${transactions.length?` (${transactions.length})`:""}`},
    {id:"settings", label:"⚙️ Settings"},
  ];

  return(
    <div style={{minHeight:"100vh",background:"#0A0A0F",color:"#F0EDE8",fontFamily:"'Noto Sans','Segoe UI',sans-serif",display:"flex",flexDirection:"column",alignItems:"center",padding:"0 16px 100px"}}>
      <style>{`
        @keyframes pulse{0%{transform:scale(.8);opacity:1}100%{transform:scale(1.5);opacity:0}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        @keyframes pop{0%{transform:scale(.8)}60%{transform:scale(1.1)}100%{transform:scale(1)}}
        input::placeholder{color:#444}input:focus{outline:none;border-color:rgba(255,107,53,.5)}
        button:active{opacity:.85}::-webkit-scrollbar{display:none}
      `}</style>
      <div style={{position:"fixed",top:"-100px",left:"50%",transform:"translateX(-50%)",width:"500px",height:"500px",background:"radial-gradient(circle,rgba(255,107,53,.08) 0%,transparent 70%)",pointerEvents:"none",zIndex:0}}/>

      {/* Header + tabs */}
      <div style={{width:"100%",maxWidth:"420px",paddingTop:"44px",marginBottom:"20px",position:"relative",zIndex:1}}>
        <div style={{fontSize:"10px",letterSpacing:"4px",color:"#FF6B35",marginBottom:"8px"}}>VOICE UPI · v0.4</div>
        <h1 style={{fontSize:"28px",fontWeight:"800",margin:"0 0 16px",lineHeight:1}}>बोलो और भेजो</h1>
        <div style={{display:"flex",gap:"6px",overflowX:"auto",paddingBottom:"2px"}}>
          {tabs.map(tab=>(
            <button key={tab.id} onClick={()=>{setScreen(tab.id);if(tab.id!=="pay")reset();}}
              style={{flexShrink:0,padding:"9px 14px",borderRadius:"12px",border:"none",cursor:"pointer",background:screen===tab.id?"rgba(255,107,53,.15)":"rgba(255,255,255,.04)",color:screen===tab.id?"#FF6B35":"#555",fontSize:"12px",fontWeight:screen===tab.id?700:400,borderBottom:screen===tab.id?"2px solid #FF6B35":"2px solid transparent",whiteSpace:"nowrap"}}>
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* ══ PAY ══ */}
      {screen==="pay"&&(
        <div style={{width:"100%",maxWidth:"420px",position:"relative",zIndex:1,display:"flex",flexDirection:"column",alignItems:"center"}}>

          {/* iOS Safari hint */}
          {IS_IOS&&!HAS_SPEECH&&(
            <div style={{width:"100%",marginBottom:"16px",background:"rgba(255,107,53,.06)",border:"1px solid rgba(255,107,53,.25)",borderRadius:"14px",padding:"14px 18px",fontSize:"13px",color:"#FF6B35",lineHeight:1.6}}>
              🎙 Voice requires <strong>Safari</strong> on iPhone.<br/>
              <span style={{color:"#666"}}>Open this page in Safari, or use the text box below.</span>
            </div>
          )}

          {contacts.length===0&&(
            <div style={{width:"100%",marginBottom:"20px",background:"rgba(255,107,53,.06)",border:"1px solid rgba(255,107,53,.2)",borderRadius:"14px",padding:"14px 18px",fontSize:"13px",color:"#FF6B35"}}>
              👆 Add contacts in the <strong>Contacts</strong> tab first
            </div>
          )}

          {/* iOS always shows which app will open (compact, unobtrusive) */}
          {IS_IOS&&(
            <div style={{width:"100%",marginBottom:"14px",background:"rgba(255,255,255,.02)",border:"1px solid rgba(255,255,255,.06)",borderRadius:"10px",padding:"8px 14px",fontSize:"12px",color:"#444",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span>Opens in: <strong style={{color:"#666"}}>{UPI_APPS.find(a=>a.id===preferredApp)?.label||"PhonePe"}</strong></span>
              <button onClick={()=>setScreen("settings")} style={{background:"none",border:"none",color:"#FF6B35",fontSize:"11px",cursor:"pointer",padding:"2px 0"}}>Change ›</button>
            </div>
          )}

          {/* Mic button */}
          {(!textMode||HAS_SPEECH)&&(
            <div style={{position:"relative",marginBottom:"24px",display:"flex",alignItems:"center",justifyContent:"center"}}>
              {pulseRings&&[1,2,3].map(i=>(
                <div key={i} style={{position:"absolute",width:`${90+i*55}px`,height:`${90+i*55}px`,borderRadius:"50%",border:`1px solid rgba(255,107,53,${.5-i*.12})`,animation:`pulse ${.7+i*.25}s ease-out infinite`,animationDelay:`${i*.15}s`}}/>
              ))}
              <button
                onMouseDown={["idle","error","success"].includes(phase)?startListening:undefined}
                onMouseUp={phase==="listening"?stopListening:undefined}
                onTouchStart={["idle","error","success"].includes(phase)?startListening:undefined}
                onTouchEnd={phase==="listening"?stopListening:undefined}
                style={{width:"96px",height:"96px",borderRadius:"50%",zIndex:10,
                  background:phase==="listening"?"radial-gradient(circle,#FF6B35,#C93D0A)":phase==="success"?"radial-gradient(circle,#22C55E,#16A34A)":"radial-gradient(circle,#1C1C1C,#111)",
                  border:phase==="listening"?"2px solid rgba(255,107,53,.9)":phase==="success"?"2px solid rgba(34,197,94,.6)":"2px solid rgba(255,255,255,.07)",
                  boxShadow:phase==="listening"?"0 0 50px rgba(255,107,53,.5)":phase==="success"?"0 0 40px rgba(34,197,94,.35)":"0 10px 40px rgba(0,0,0,.6)",
                  cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"34px",transition:"all .25s ease",WebkitTapHighlightColor:"transparent",
                  animation:phase==="success"?"pop .4s ease":"none"}}>
                {["processing","paying"].includes(phase)
                  ?<div style={{width:"26px",height:"26px",borderRadius:"50%",border:`2px solid ${phase==="paying"?"rgba(34,197,94,.3)":"rgba(255,107,53,.3)"}`,borderTop:`2px solid ${phase==="paying"?"#22C55E":"#FF6B35"}`,animation:"spin .7s linear infinite"}}/>
                  :phase==="success"?"✓":"🎙️"}
              </button>
            </div>
          )}

          {/* Status text */}
          <div style={{textAlign:"center",marginBottom:"20px",minHeight:"48px",width:"100%",animation:"fadeUp .3s ease"}}>
            {phase==="idle"&&!textMode&&<p style={{color:"#444",fontSize:"14px",margin:0}}>Hold to speak · बोलने के लिए दबाएं</p>}
            {phase==="listening"&&<>
              <p style={{color:"#FF6B35",fontSize:"14px",margin:"0 0 8px",fontWeight:600}}>सुन रहा हूँ…</p>
              {transcript&&<div style={{background:"rgba(255,107,53,.08)",border:"1px solid rgba(255,107,53,.15)",borderRadius:"14px",padding:"10px 18px",fontSize:"15px",maxWidth:"320px",margin:"0 auto"}}>"{transcript}"</div>}
            </>}
            {phase==="processing"&&<p style={{color:"#666",fontSize:"14px",margin:0}}>{useClaudeParser?"Claude is thinking…":"समझ रहा हूँ…"}</p>}
            {phase==="paying"   &&<p style={{color:"#22C55E",fontSize:"14px",margin:0,fontWeight:600}}>Opening {UPI_APPS.find(a=>a.id===preferredApp)?.label||"UPI app"}…</p>}
            {phase==="error"    &&<div>
              <p style={{color:"#EF4444",fontSize:"14px",margin:"0 0 10px"}}>{errorMsg}</p>
              <button onClick={reset} style={{background:"none",border:"1px solid #333",color:"#666",borderRadius:"8px",padding:"6px 18px",fontSize:"12px",cursor:"pointer"}}>Try Again</button>
            </div>}
          </div>

          {/* Success card */}
          {phase==="success"&&lastPaid&&(
            <div style={{width:"100%",marginBottom:"20px",background:"rgba(34,197,94,.05)",border:"1px solid rgba(34,197,94,.18)",borderRadius:"20px",padding:"22px",textAlign:"center",animation:"fadeUp .4s ease"}}>
              <div style={{fontSize:"36px",marginBottom:"8px"}}>✅</div>
              <div style={{fontSize:"20px",fontWeight:800,color:"#22C55E",marginBottom:"4px"}}>{UPI_APPS.find(a=>a.id===preferredApp)?.label||"UPI"} Opened!</div>
              <div style={{color:"#555",fontSize:"13px",marginBottom:"14px"}}>to {lastPaid.to} · ₹{lastPaid.amount?.toLocaleString("en-IN")}</div>
              <button onClick={reset} style={{background:"none",border:"1px solid rgba(34,197,94,.3)",color:"#22C55E",borderRadius:"10px",padding:"10px 24px",fontSize:"14px",cursor:"pointer"}}>New Payment</button>
            </div>
          )}

          {/* Text input fallback */}
          <div style={{width:"100%",marginTop:"8px"}}>
            <button onClick={()=>setTextMode(m=>!m)} style={{background:"none",border:"none",color:"#333",fontSize:"12px",cursor:"pointer",marginBottom:"8px",padding:"4px 0"}}>
              {textMode?"🎙️ Switch to voice":"⌨️ Type instead"}
            </button>
            {textMode&&(
              <div style={{display:"flex",gap:"8px"}}>
                <input
                  value={textInput}
                  onChange={e=>setTextInput(e.target.value)}
                  onKeyDown={e=>e.key==="Enter"&&textInput.trim()&&parseAndPay(textInput)}
                  placeholder='e.g. "Rahul ko 200 rupaye"'
                  style={{flex:1,background:"rgba(255,255,255,.05)",border:"1px solid rgba(255,255,255,.1)",color:"#F0EDE8",borderRadius:"10px",padding:"11px 14px",fontSize:"14px"}}
                />
                <button onClick={()=>textInput.trim()&&parseAndPay(textInput)}
                  style={{background:"linear-gradient(135deg,#FF6B35,#F7931E)",border:"none",color:"#fff",borderRadius:"10px",padding:"11px 18px",fontSize:"14px",fontWeight:700,cursor:"pointer"}}>
                  Send
                </button>
              </div>
            )}
          </div>

          {/* Contact chips */}
          {phase==="idle"&&contacts.length>0&&!textMode&&(
            <div style={{width:"100%",marginTop:"20px",marginBottom:"4px"}}>
              <div style={{fontSize:"10px",color:"#333",letterSpacing:"3px",marginBottom:"10px"}}>SAY THEIR NAME →</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:"8px"}}>
                {contacts.map((c,i)=>(
                  <div key={i} style={{background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.08)",borderRadius:"20px",padding:"6px 14px",fontSize:"13px",color:"#777"}}>
                    {c.avatar} {c.name}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Debug transcript */}
          {transcript&&phase!=="listening"&&(
            <div style={{width:"100%",marginTop:"12px",background:"rgba(255,255,100,.02)",border:"1px solid rgba(255,255,100,.08)",borderRadius:"12px",padding:"12px 16px"}}>
              <div style={{fontSize:"10px",color:"#444",letterSpacing:"2px",marginBottom:"4px"}}>🎙 HEARD</div>
              <div style={{fontSize:"13px",color:"#666",fontFamily:"monospace"}}>"{transcript}"</div>
            </div>
          )}
        </div>
      )}

      {/* ══ CONTACTS ══ */}
      {screen==="contacts"&&<ContactsScreen contacts={contacts} setContacts={setContacts}/>}

      {/* ══ HISTORY ══ */}
      {screen==="history"&&(
        <div style={{width:"100%",maxWidth:"420px",animation:"fadeUp .3s ease"}}>
          {transactions.length===0
            ?<div style={{textAlign:"center",color:"#444",fontSize:"14px",padding:"50px 30px"}}>No transactions yet.<br/>Make your first voice payment! 🎙️</div>
            :<>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"14px"}}>
                <div style={{fontSize:"10px",color:"#333",letterSpacing:"3px"}}>TRANSACTIONS ({transactions.length})</div>
                <button onClick={()=>{if(window.confirm("Clear all history?")){setTransactions([]);localStorage.removeItem("vp_txns");}}}
                  style={{background:"none",border:"1px solid rgba(239,68,68,.2)",color:"#EF4444",borderRadius:"8px",padding:"5px 12px",fontSize:"11px",cursor:"pointer"}}>Clear</button>
              </div>
              {transactions.map((t,i)=>(
                <div key={i} style={{background:"rgba(255,255,255,.02)",border:"1px solid rgba(255,255,255,.04)",borderRadius:"14px",padding:"13px 16px",marginBottom:"8px",display:"flex",alignItems:"center",gap:"12px"}}>
                  <div style={{width:"40px",height:"40px",borderRadius:"50%",background:"#1A1A2E",border:"1px solid rgba(255,107,53,.15)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"15px",fontWeight:700,color:"#FF6B35",flexShrink:0}}>{t.avatar}</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:"14px",fontWeight:600}}>{t.to}</div>
                    <div style={{fontSize:"11px",color:"#444",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.upi}</div>
                    {t.note&&<div style={{fontSize:"11px",color:"#555",marginTop:"2px"}}>📝 {t.note}</div>}
                  </div>
                  <div style={{textAlign:"right",flexShrink:0}}>
                    <div style={{fontSize:"16px",fontWeight:700,color:"#FF6B35"}}>−₹{t.amount?.toLocaleString("en-IN")}</div>
                    <div style={{fontSize:"10px",color:"#444"}}>{t.date} {t.time}</div>
                    <div style={{fontSize:"10px",color:"#333",fontFamily:"monospace"}}>{t.id}</div>
                  </div>
                </div>
              ))}
            </>
          }
        </div>
      )}

      {/* ══ SETTINGS ══ */}
      {screen==="settings"&&(
        <SettingsScreen
          claudeKey={claudeKey} setClaudeKey={setClaudeKey}
          useClaudeParser={useClaudeParser} setUseClaudeParser={setUseClaudeParser}
          preferredApp={preferredApp} setPreferredApp={setPreferredApp}
        />
      )}

      <div style={{marginTop:"32px",fontSize:"11px",color:"#1E1E1E",textAlign:"center"}}>
        v0.4 · {IS_IOS?"iOS":"Android"} · {useClaudeParser?"CLAUDE":"LOCAL"} PARSER
      </div>
    </div>
  );
}
