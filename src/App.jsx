import { useState, useEffect } from "react";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, onSnapshot, doc, setDoc, deleteDoc } from "firebase/firestore";

// ─── FIREBASE ──────────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyA6T5QbCsW27l1hNGR4MsIU2WEtAJLs9yo",
  authDomain: "status-videos-55e13.firebaseapp.com",
  projectId: "status-videos-55e13",
  storageBucket: "status-videos-55e13.firebasestorage.app",
  messagingSenderId: "523770472167",
  appId: "1:523770472167:web:31c49d21a07db735292442",
  measurementId: "G-5B03TQKCTS"
};
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// ─── CONFIG ────────────────────────────────────────────────────────────────────

const STAGE_DEFS = [
  {
    id: "roteiro", label: "Roteiro", icon: "✍️",
    color: "#7B8CFF",
    substeps: ["Pesquisa", "Estrutura", "Escrita", "Revisão do roteiro", "Aprovação"],
  },
  {
    id: "captacao", label: "Captação", icon: "🎥",
    color: "#FF6B9D", optional: true,
    substeps: ["Preparo de cenário", "Gravação principal", "Takes alternativos"],
  },
  {
    id: "edicao", label: "Edição", icon: "✂️",
    color: "#FFA502",
    substeps: ["Decupagem", "Montagem", "Trilhas de áudio", "Colorização", "Efeitos", "Legendas"],
  },
  {
    id: "revisao", label: "Revisão", icon: "👁",
    color: "#A29BFE",
    substeps: ["Revisão interna", "Ajustes finais", "Aprovação final"],
  },
  {
    id: "publicacao", label: "Publicação", icon: "🚀",
    color: "#2ED573",
    substeps: ["Publicação", "Divulgação"],
  },
];

const WEIGHTS_WITH    = { roteiro: 0.20, captacao: 0.30, edicao: 0.30, revisao: 0.10, publicacao: 0.10 };
const WEIGHTS_WITHOUT = { roteiro: 0.2857, captacao: 0, edicao: 0.4286, revisao: 0.1429, publicacao: 0.1429 };

const PRIORITY_CONFIG = {
  Alta:  { color: "#FF4757", bg: "rgba(255,71,87,0.12)"  },
  Média: { color: "#FFA502", bg: "rgba(255,165,2,0.12)"  },
  Baixa: { color: "#2ED573", bg: "rgba(46,213,115,0.12)" },
};

function progressColor(pct) {
  if (pct === 0)  return "#2a2a42";
  if (pct < 25)   return "#FF4757";
  if (pct < 50)   return "#FF6B35";
  if (pct < 75)   return "#FFA502";
  if (pct < 95)   return "#7BED9F";
  return "#2ED573";
}

const STORAGE_KEY = "video-kanban-v2";
function genId() { return Math.random().toString(36).slice(2, 9); }

// ─── CALCULATIONS ───────────────────────────────────────────────────────────────

function calcStageProgress(card, stageId) {
  const def = STAGE_DEFS.find((s) => s.id === stageId);
  if (!def) return 0;
  const data = card.stages?.[stageId] || {};
  const sum = def.substeps.reduce((a, s) => a + (data[s] || 0), 0);
  return Math.round(sum / def.substeps.length);
}

function calcOverallProgress(card) {
  const w = card.hasCaptacao ? WEIGHTS_WITH : WEIGHTS_WITHOUT;
  let total = 0;
  STAGE_DEFS.forEach((s) => {
    if (!card.hasCaptacao && s.id === "captacao") return;
    total += calcStageProgress(card, s.id) * w[s.id];
  });
  return Math.round(total);
}

function estimateDeadline(card) {
  if (!card.dueDate || !card.createdAt) return null;
  const overall = calcOverallProgress(card) / 100;
  if (overall <= 0) return null;
  const created = new Date(card.createdAt);
  const due = new Date(card.dueDate + "T12:00:00");
  const now = new Date();
  const elapsed = now - created;
  const estimated = new Date(created.getTime() + elapsed / overall);
  const diffDays = Math.round((estimated - due) / 86400000);
  return { estimated, diffDays };
}

function getActiveStage(card) {
  const visible = STAGE_DEFS.filter((s) => card.hasCaptacao || s.id !== "captacao");
  return visible.find((s) => calcStageProgress(card, s.id) < 100) || visible[visible.length - 1];
}

// ─── SUB-STEP SLIDER ────────────────────────────────────────────────────────────

function SubStepRow({ label, value, onChange }) {
  const color = progressColor(value);
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 7 }}>
        <span style={{ fontSize: 12, color: "#999", fontFamily: "'DM Sans',sans-serif" }}>{label}</span>
        <span style={{ fontSize: 12, fontWeight: 800, color, fontFamily: "'Syne',sans-serif", minWidth: 36, textAlign: "right" }}>{value}%</span>
      </div>
      <div style={{ position: "relative", height: 7, background: "#1a1a2e", borderRadius: 4 }}>
        <div style={{ position: "absolute", inset: 0, width: `${value}%`, background: color, borderRadius: 4, transition: "width .2s, background .3s", boxShadow: value > 0 ? `0 0 10px ${color}66` : "none" }} />
        <input type="range" min={0} max={100} step={5} value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer", margin: 0 }} />
      </div>
    </div>
  );
}

// ─── MODAL ──────────────────────────────────────────────────────────────────────

function CardModal({ card, onSave, onClose }) {
  const blank = { id: genId(), title: "", responsible: "", areaDemandante: "", dueDate: "", priority: "Média", hasCaptacao: true, stages: {}, createdAt: new Date().toISOString() };
  const [form, setForm] = useState(card ? JSON.parse(JSON.stringify(card)) : blank);
  const [tab, setTab] = useState(STAGE_DEFS[0].id);

  const set = (f, v) => setForm((p) => ({ ...p, [f]: v }));
  const setStep = (stageId, step, val) =>
    setForm((p) => ({ ...p, stages: { ...p.stages, [stageId]: { ...(p.stages[stageId] || {}), [step]: val } } }));

  const visibleStages = STAGE_DEFS.filter((s) => form.hasCaptacao || s.id !== "captacao");
  const overall = calcOverallProgress(form);
  const overallColor = progressColor(overall);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(4,4,12,.9)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, backdropFilter: "blur(10px)" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#0d0d1a", border: "1px solid #1e1e38", borderRadius: 24, width: 600, maxWidth: "96vw", maxHeight: "94vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 40px 120px rgba(0,0,0,.8)", animation: "popIn .22s cubic-bezier(.34,1.56,.64,1)" }}>

        {/* Header */}
        <div style={{ padding: "26px 26px 18px", borderBottom: "1px solid #18182e" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
            <span style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 16, color: "#fff" }}>{card ? "Editar vídeo" : "Novo vídeo"}</span>
            <button onClick={onClose} style={{ background: "none", border: "none", color: "#444", fontSize: 22, cursor: "pointer" }}>×</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
            {[["Título","title","text","Nome do vídeo...",2],["Área demandante","areaDemandante","text","Ex: Marketing, RH…",1],["Responsável","responsible","text","Quem cuida?",1],["Data prevista","dueDate","date","",1]].map(([label,field,type,placeholder,span]) => (
              <div key={field} style={{ gridColumn: `span ${span}` }}>
                <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: "#444", letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 6, fontFamily: "'Syne',sans-serif" }}>{label}</label>
                <input type={type} value={form[field]} onChange={(e) => set(field, e.target.value)} placeholder={placeholder}
                  style={{ width: "100%", padding: "10px 12px", borderRadius: 9, background: "#14142a", border: "1px solid #1e1e38", color: "#fff", fontSize: 13, outline: "none", fontFamily: "'DM Sans',sans-serif", colorScheme: "dark" }} />
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: "#444", letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 6, fontFamily: "'Syne',sans-serif" }}>Prioridade</label>
              <div style={{ display: "flex", gap: 6 }}>
                {Object.entries(PRIORITY_CONFIG).map(([p, cfg]) => (
                  <button key={p} onClick={() => set("priority", p)}
                    style={{ flex: 1, padding: "8px 4px", borderRadius: 8, border: `1.5px solid ${form.priority === p ? cfg.color : "#1e1e38"}`, background: form.priority === p ? cfg.bg : "transparent", color: form.priority === p ? cfg.color : "#444", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "'Syne',sans-serif", transition: "all .15s" }}>
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: "#444", letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 6, fontFamily: "'Syne',sans-serif" }}>Captação?</label>
              <button onClick={() => set("hasCaptacao", !form.hasCaptacao)}
                style={{ padding: "8px 18px", borderRadius: 8, border: `1.5px solid ${form.hasCaptacao ? "#FF6B9D" : "#1e1e38"}`, background: form.hasCaptacao ? "rgba(255,107,157,.12)" : "transparent", color: form.hasCaptacao ? "#FF6B9D" : "#444", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "'Syne',sans-serif", transition: "all .15s" }}>
                {form.hasCaptacao ? "Sim" : "Não"}
              </button>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 2, padding: "0 26px", borderBottom: "1px solid #18182e", overflowX: "auto" }}>
          {visibleStages.map((s) => {
            const p = calcStageProgress(form, s.id);
            return (
              <button key={s.id} onClick={() => setTab(s.id)}
                style={{ padding: "11px 12px", background: "none", border: "none", borderBottom: `2.5px solid ${tab === s.id ? s.color : "transparent"}`, color: tab === s.id ? s.color : "#555", cursor: "pointer", fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 11, whiteSpace: "nowrap", transition: "color .15s", display: "flex", alignItems: "center", gap: 5 }}>
                {s.icon} {s.label}
                {p > 0 && <span style={{ fontSize: 9, color: progressColor(p), background: progressColor(p) + "22", padding: "1px 6px", borderRadius: 10 }}>{p}%</span>}
              </button>
            );
          })}
        </div>

        {/* Sub-steps */}
        <div style={{ padding: "22px 26px", overflowY: "auto", flex: 1 }}>
          {STAGE_DEFS.find((s) => s.id === tab)?.substeps.map((step) => (
            <SubStepRow key={step} label={step} value={form.stages?.[tab]?.[step] || 0} onChange={(v) => setStep(tab, step, v)} />
          ))}
          {/* Progress preview */}
          <div style={{ marginTop: 10, padding: "14px 16px", background: "#14142a", borderRadius: 12, border: "1px solid #1e1e38" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#555", letterSpacing: ".08em", textTransform: "uppercase", fontFamily: "'Syne',sans-serif" }}>Progresso Geral</span>
              <span style={{ fontSize: 16, fontWeight: 800, color: overallColor, fontFamily: "'Syne',sans-serif" }}>{overall}%</span>
            </div>
            <div style={{ height: 7, background: "#0a0a14", borderRadius: 4 }}>
              <div style={{ height: "100%", width: `${overall}%`, background: `linear-gradient(90deg,${progressColor(Math.max(0,overall-30))},${overallColor})`, borderRadius: 4, transition: "width .3s", boxShadow: overall > 0 ? `0 0 12px ${overallColor}55` : "none" }} />
            </div>
            <div style={{ display: "flex", gap: 4, marginTop: 10 }}>
              {visibleStages.map((s) => {
                const p = calcStageProgress(form, s.id);
                return <div key={s.id} title={`${s.label}: ${p}%`} style={{ flex: 1, height: 3, borderRadius: 2, background: p > 0 ? progressColor(p) : "#1e1e38", transition: "background .3s" }} />;
              })}
            </div>
          </div>
        </div>

        {/* Save */}
        <div style={{ padding: "14px 26px", borderTop: "1px solid #18182e" }}>
          <button onClick={() => { if (form.title.trim()) onSave(form); }}
            style={{ width: "100%", padding: 13, borderRadius: 12, border: "none", background: "linear-gradient(135deg,#7B8CFF,#A29BFE)", color: "#fff", fontWeight: 800, fontSize: 13, cursor: "pointer", fontFamily: "'Syne',sans-serif" }}>
            {card ? "Salvar alterações" : "Adicionar vídeo"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── KANBAN CARD ────────────────────────────────────────────────────────────────

function VideoCard({ card, onEdit, onDelete }) {
  const overall = calcOverallProgress(card);
  const color = progressColor(overall);
  const prio = PRIORITY_CONFIG[card.priority];
  const activeStage = getActiveStage(card);
  const activeP = calcStageProgress(card, activeStage.id);
  const deadline = estimateDeadline(card);
  const visible = STAGE_DEFS.filter((s) => card.hasCaptacao || s.id !== "captacao");

  return (
    <div onClick={() => onEdit(card)}
      style={{ background: "#0d0d1a", border: "1px solid #16162a", borderRadius: 14, padding: "15px", marginBottom: 10, cursor: "pointer", position: "relative", overflow: "hidden", transition: "transform .15s, box-shadow .15s, border-color .15s" }}
      onMouseOver={(e) => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.borderColor = color + "55"; e.currentTarget.style.boxShadow = `0 8px 28px rgba(0,0,0,.5)`; }}
      onMouseOut={(e) => { e.currentTarget.style.transform = ""; e.currentTarget.style.borderColor = "#16162a"; e.currentTarget.style.boxShadow = ""; }}>

      <div style={{ position: "absolute", top: 0, left: 0, width: 3, height: "100%", background: color, borderRadius: "3px 0 0 3px", transition: "background .3s", boxShadow: `0 0 8px ${color}88` }} />

      <div style={{ paddingLeft: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
          <span style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 12, color: "#e0e0ff", flex: 1, paddingRight: 6, lineHeight: 1.4 }}>{card.title}</span>
          <button onClick={(e) => { e.stopPropagation(); onDelete(card.id); }}
            style={{ background: "none", border: "none", color: "#2a2a44", fontSize: 16, cursor: "pointer", padding: 0, lineHeight: 1, flexShrink: 0, transition: "color .15s" }}
            onMouseOver={(e) => e.target.style.color = "#ff4757"} onMouseOut={(e) => e.target.style.color = "#2a2a44"}>×</button>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 11 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: prio.color, background: prio.bg, padding: "2px 8px", borderRadius: 20, fontFamily: "'DM Sans',sans-serif" }}>{card.priority}</span>
          {card.areaDemandante && <span style={{ fontSize: 10, color: "#7B8CFF", background: "rgba(123,140,255,.12)", padding: "2px 8px", borderRadius: 20, fontWeight: 700 }}>🏢 {card.areaDemandante}</span>}
          {card.responsible && <span style={{ fontSize: 10, color: "#666", background: "#14142a", padding: "2px 8px", borderRadius: 20 }}>👤 {card.responsible}</span>}
        </div>

        {/* Active stage */}
        <div style={{ marginBottom: 11, padding: "9px 10px", background: "#14142a", borderRadius: 9, border: `1px solid ${activeStage.color}25` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 10, color: activeStage.color, fontWeight: 700, fontFamily: "'Syne',sans-serif" }}>{activeStage.icon} {activeStage.label}</span>
            <span style={{ fontSize: 11, fontWeight: 800, color: progressColor(activeP), fontFamily: "'Syne',sans-serif" }}>{activeP}%</span>
          </div>
          <div style={{ height: 4, background: "#0a0a14", borderRadius: 2 }}>
            <div style={{ height: "100%", width: `${activeP}%`, background: progressColor(activeP), borderRadius: 2, transition: "width .3s", boxShadow: activeP > 0 ? `0 0 6px ${progressColor(activeP)}88` : "none" }} />
          </div>
        </div>

        {/* Overall */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
            <span style={{ fontSize: 9, color: "#444", letterSpacing: ".07em", textTransform: "uppercase", fontFamily: "'Syne',sans-serif" }}>Geral</span>
            <span style={{ fontSize: 11, fontWeight: 800, color, fontFamily: "'Syne',sans-serif" }}>{overall}%</span>
          </div>
          <div style={{ height: 5, background: "#14142a", borderRadius: 3 }}>
            <div style={{ height: "100%", width: `${overall}%`, background: `linear-gradient(90deg,${progressColor(Math.max(0,overall-30))},${color})`, borderRadius: 3, transition: "width .3s", boxShadow: overall > 0 ? `0 0 8px ${color}66` : "none" }} />
          </div>
        </div>

        {/* Stage dots */}
        <div style={{ display: "flex", gap: 3, marginBottom: 10 }}>
          {visible.map((s) => {
            const p = calcStageProgress(card, s.id);
            return <div key={s.id} title={`${s.label}: ${p}%`} style={{ flex: 1, height: 3, borderRadius: 2, background: p > 0 ? progressColor(p) : "#1e1e38", transition: "background .3s", boxShadow: p > 0 ? `0 0 4px ${progressColor(p)}66` : "none" }} />;
          })}
        </div>

        {/* Deadline */}
        {card.dueDate && (
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#555", fontFamily: "'DM Sans',sans-serif" }}>
            <span>📅 {new Date(card.dueDate + "T12:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })}</span>
            {deadline && (
              <span style={{ fontWeight: 800, color: deadline.diffDays > 3 ? "#FF4757" : deadline.diffDays > 0 ? "#FFA502" : "#2ED573" }}>
                {deadline.diffDays > 0 ? `+${deadline.diffDays}d` : deadline.diffDays < 0 ? `${Math.abs(deadline.diffDays)}d antes` : "no prazo"}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── NAME PROMPT ────────────────────────────────────────────────────────────────

function NamePrompt({ onConfirm }) {
  const [input, setInput] = useState("");
  return (
    <div style={{ position: "fixed", inset: 0, background: "#07070f", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000, fontFamily: "'DM Sans',sans-serif" }}>
      <div style={{ textAlign: "center", animation: "fadeUp .4s ease both" }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".2em", textTransform: "uppercase", color: "#7B8CFF", marginBottom: 12, fontFamily: "'Syne',sans-serif" }}>Painel de Vídeos</div>
        <h2 style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: "clamp(22px,4vw,34px)", color: "#fff", letterSpacing: "-.03em", marginBottom: 8 }}>Qual é a sua área?</h2>
        <p style={{ color: "#555", fontSize: 13, marginBottom: 32 }}>Vamos mostrar o status do seu vídeo assim que você entrar.</p>
        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
          <input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && input.trim() && onConfirm(input.trim())}
            placeholder="Ex: Marketing, RH, Comercial…"
            style={{ padding: "13px 18px", borderRadius: 12, background: "#0d0d1a", border: "1px solid #1e1e38", color: "#fff", fontSize: 14, outline: "none", width: 280, fontFamily: "'DM Sans',sans-serif", colorScheme: "dark" }}
          />
          <button
            onClick={() => input.trim() && onConfirm(input.trim())}
            style={{ padding: "13px 24px", borderRadius: 12, border: "none", background: "linear-gradient(135deg,#7B8CFF,#A29BFE)", color: "#fff", fontWeight: 800, fontSize: 13, cursor: "pointer", fontFamily: "'Syne',sans-serif" }}>
            Entrar
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── FOOTER BANNER ───────────────────────────────────────────────────────────────

function FooterBanner({ card, areaName }) {
  if (!card) return (
    <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "#0d0d1a", borderTop: "1px solid #1a1a2e", padding: "14px 28px", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 500 }}>
      <span style={{ fontSize: 12, color: "#333", fontFamily: "'Syne',sans-serif", fontStyle: "italic" }}>
        Nenhum vídeo encontrado para <strong style={{ color: "#444" }}>{areaName}</strong>. Aguarde o cadastro pela equipe de produção.
      </span>
    </div>
  );

  const overall = calcOverallProgress(card);
  const color = progressColor(overall);
  const deadline = estimateDeadline(card);
  const activeStage = getActiveStage(card);

  // Data prevista (definida pelo produtor)
  const dueDateObj = card.dueDate ? new Date(card.dueDate + "T12:00:00") : null;
  const dueDateText = dueDateObj
    ? dueDateObj.toLocaleDateString("pt-BR", { day: "2-digit", month: "long" })
    : "—";

  // Data estimada (calculada pelo ritmo)
  let estimatedText = null;
  let estimatedEmoji = null;
  let estimatedColor = "#aaa";

  if (overall === 100) {
    estimatedText = "Concluído! ✅";
    estimatedColor = "#2ED573";
  } else if (deadline) {
    const est = deadline.estimated;
    estimatedText = est.toLocaleDateString("pt-BR", { day: "2-digit", month: "long" });
    if (dueDateObj) {
      const diffDays = Math.round((est - dueDateObj) / 86400000);
      if (diffDays < 0) {
        estimatedEmoji = "😊";
        estimatedColor = "#2ED573";
      } else if (diffDays === 0) {
        estimatedEmoji = "✅";
        estimatedColor = "#2ED573";
      } else {
        estimatedEmoji = "⚠️";
        estimatedColor = "#FFA502";
      }
    }
  }

  return (
    <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "#0a0a16", borderTop: `1px solid ${color}33`, zIndex: 500, overflow: "hidden" }}>
      {/* Progress bar along the very bottom edge */}
      <div style={{ position: "absolute", bottom: 0, left: 0, height: 3, width: `${overall}%`, background: `linear-gradient(90deg,${progressColor(Math.max(0,overall-30))},${color})`, transition: "width .6s", boxShadow: `0 0 10px ${color}88` }} />

      <div style={{ maxWidth: 1440, margin: "0 auto", padding: "12px 24px", display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>

        {/* Area + title */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: color + "22", border: `1px solid ${color}44`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0 }}>
            {activeStage.icon}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#444", letterSpacing: ".1em", textTransform: "uppercase", fontFamily: "'Syne',sans-serif" }}>{areaName}</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#ccc", fontFamily: "'Syne',sans-serif", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 200 }}>{card.title}</div>
          </div>
        </div>

        {/* Divider */}
        <div style={{ width: 1, height: 30, background: "#1a1a2e", flexShrink: 0 }} />

        {/* Big message */}
        <div style={{ flex: 1, minWidth: 220, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
          <span style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: "clamp(13px,1.8vw,16px)", color: "#fff", letterSpacing: "-.02em", whiteSpace: "nowrap" }}>
            SEU VÍDEO ESTÁ{" "}
            <span style={{ color, textShadow: `0 0 20px ${color}` }}>{overall}% PRONTO</span>
          </span>

          <span style={{ color: "#2a2a44", fontSize: 14 }}>·</span>

          {/* Data prevista */}
          <span style={{ fontFamily: "'Syne',sans-serif", fontSize: "clamp(10px,1.3vw,13px)", color: "#555", whiteSpace: "nowrap" }}>
            📅 PREVISTA:{" "}
            <span style={{ color: "#aaa", fontWeight: 700 }}>{dueDateText}</span>
          </span>

          {/* Data estimada */}
          {estimatedText && (
            <>
              <span style={{ color: "#2a2a44", fontSize: 14 }}>·</span>
              <span style={{ fontFamily: "'Syne',sans-serif", fontSize: "clamp(10px,1.3vw,13px)", color: "#555", whiteSpace: "nowrap" }}>
                ⚡ ESTIMADA:{" "}
                <span style={{ color: estimatedColor, fontWeight: 700 }}>
                  {estimatedText}{estimatedEmoji ? ` ${estimatedEmoji}` : ""}
                </span>
              </span>
            </>
          )}
        </div>

        {/* Stage pill */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 13px", background: activeStage.color + "15", border: `1px solid ${activeStage.color}33`, borderRadius: 20, flexShrink: 0 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: activeStage.color, fontFamily: "'Syne',sans-serif" }}>{activeStage.label}</span>
          <span style={{ fontSize: 11, fontWeight: 800, color, fontFamily: "'Syne',sans-serif" }}>{calcStageProgress(card, activeStage.id)}%</span>
        </div>

      </div>
    </div>
  );
}

// ─── APP ────────────────────────────────────────────────────────────────────────

export default function App() {
  const [cards, setCards] = useState([]);
  const [modal, setModal] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState("Todos");
  const [areaName, setAreaName] = useState(null);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, "cards"), (snap) => {
      setCards(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoaded(true);
    });
    return () => unsub();
  }, []);

  async function persist(next) {
    setCards(next);
    // Sync all cards to Firestore
    const prev = cards;
    // Delete removed cards
    for (const c of prev) {
      if (!next.find((n) => n.id === c.id)) {
        await deleteDoc(doc(db, "cards", c.id));
      }
    }
    // Upsert changed/new cards
    for (const c of next) {
      await setDoc(doc(db, "cards", c.id), c);
    }
  }

  const filtered = filter === "Todos" ? cards : cards.filter((c) => c.priority === filter);
  const avgProgress = cards.length ? Math.round(cards.reduce((s, c) => s + calcOverallProgress(c), 0) / cards.length) : 0;
  const delayed = cards.filter((c) => { const d = estimateDeadline(c); return d && d.diffDays > 0; }).length;

  // Card belonging to this area (case-insensitive match)
  const myCard = areaName
    ? cards.find((c) => c.areaDemandante?.toLowerCase().trim() === areaName.toLowerCase().trim()) || null
    : null;

  if (!areaName) return <NamePrompt onConfirm={setAreaName} />;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:wght@400;500;600&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        ::-webkit-scrollbar{width:4px;height:4px;}
        ::-webkit-scrollbar-thumb{background:#1e1e38;border-radius:4px;}
        input[type=range]{-webkit-appearance:none;appearance:none;}
        @keyframes popIn{from{opacity:0;transform:scale(.92) translateY(8px);}to{opacity:1;transform:scale(1) translateY(0);}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(14px);}to{opacity:1;transform:translateY(0);}}
      `}</style>

      <div style={{ minHeight: "100vh", background: "#07070f", padding: "28px 20px 100px", fontFamily: "'DM Sans',sans-serif" }}>
        <div style={{ maxWidth: 1440, margin: "0 auto" }}>

          {/* Header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 16, marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".2em", textTransform: "uppercase", color: "#7B8CFF", marginBottom: 5, fontFamily: "'Syne',sans-serif" }}>Produção de Conteúdo</div>
              <h1 style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: "clamp(22px,3.5vw,32px)", color: "#fff", letterSpacing: "-.03em" }}>Painel de Vídeos</h1>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button onClick={() => setAreaName(null)}
                style={{ padding: "10px 16px", borderRadius: 10, border: "1px solid #1e1e38", background: "transparent", color: "#555", fontSize: 12, cursor: "pointer", fontFamily: "'Syne',sans-serif", fontWeight: 700, transition: "all .15s" }}
                onMouseOver={(e) => { e.target.style.borderColor = "#7B8CFF"; e.target.style.color = "#7B8CFF"; }}
                onMouseOut={(e) => { e.target.style.borderColor = "#1e1e38"; e.target.style.color = "#555"; }}>
                ← Trocar área
              </button>
              <button onClick={() => setModal("new")}
                style={{ padding: "12px 22px", borderRadius: 12, border: "none", background: "linear-gradient(135deg,#7B8CFF,#A29BFE)", color: "#fff", fontWeight: 800, fontSize: 13, cursor: "pointer", fontFamily: "'Syne',sans-serif", boxShadow: "0 4px 20px rgba(123,140,255,.35)", transition: "transform .15s,box-shadow .15s", whiteSpace: "nowrap" }}
                onMouseOver={(e) => { e.target.style.transform = "translateY(-2px)"; e.target.style.boxShadow = "0 8px 28px rgba(123,140,255,.45)"; }}
                onMouseOut={(e) => { e.target.style.transform = ""; e.target.style.boxShadow = "0 4px 20px rgba(123,140,255,.35)"; }}>
                + Novo vídeo
              </button>
            </div>
          </div>

          {/* Stats */}
          {loaded && cards.length > 0 && (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18 }}>
              {[
                ["Total", cards.length, null],
                ["Progresso médio", `${avgProgress}%`, progressColor(avgProgress)],
                ["Concluídos", cards.filter((c) => calcOverallProgress(c) === 100).length, "#2ED573"],
                ["Em atraso", delayed, delayed > 0 ? "#FF4757" : "#555"],
              ].map(([label, value, color]) => (
                <div key={label} style={{ padding: "9px 16px", background: "#0d0d1a", border: "1px solid #16162a", borderRadius: 10, display: "flex", gap: 10, alignItems: "center" }}>
                  <span style={{ fontSize: 10, color: "#444", fontFamily: "'Syne',sans-serif", textTransform: "uppercase", letterSpacing: ".07em" }}>{label}</span>
                  <span style={{ fontSize: 15, fontWeight: 800, color: color || "#fff", fontFamily: "'Syne',sans-serif" }}>{value}</span>
                </div>
              ))}
            </div>
          )}

          {/* Filters */}
          <div style={{ display: "flex", gap: 6, marginBottom: 22 }}>
            {["Todos", "Alta", "Média", "Baixa"].map((p) => (
              <button key={p} onClick={() => setFilter(p)}
                style={{ padding: "6px 14px", borderRadius: 8, border: `1px solid ${filter === p ? (PRIORITY_CONFIG[p]?.color || "#7B8CFF") : "#16162a"}`, background: filter === p ? (PRIORITY_CONFIG[p]?.bg || "rgba(123,140,255,.12)") : "transparent", color: filter === p ? (PRIORITY_CONFIG[p]?.color || "#7B8CFF") : "#444", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "'Syne',sans-serif", transition: "all .15s" }}>
                {p}
              </button>
            ))}
          </div>

          {/* Board */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 10, overflowX: "auto" }}>
            {STAGE_DEFS.map((stage, i) => {
              const col = filtered.filter((c) => getActiveStage(c).id === stage.id);
              return (
                <div key={stage.id} style={{ background: "#0a0a16", border: "1px solid #12122a", borderRadius: 18, padding: "15px 12px", minWidth: 190, animation: `fadeUp .4s ease ${i * .07}s both` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 14 }}>{stage.icon}</span>
                      <span style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, fontSize: 11, color: "#aaa" }}>{stage.label}</span>
                    </div>
                    <span style={{ background: stage.color + "22", color: stage.color, borderRadius: 20, padding: "1px 9px", fontSize: 10, fontWeight: 800, fontFamily: "'Syne',sans-serif" }}>{col.length}</span>
                  </div>
                  <div style={{ height: 2, background: `linear-gradient(90deg,${stage.color},transparent)`, borderRadius: 2, marginBottom: 14, opacity: .5 }} />
                  {col.length === 0
                    ? <div style={{ textAlign: "center", padding: "28px 0", color: "#1e1e38", fontSize: 11, fontStyle: "italic" }}>Vazio</div>
                    : col.map((card) => <VideoCard key={card.id} card={card} onEdit={setModal} onDelete={(id) => persist(cards.filter((c) => c.id !== id))} />)}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <FooterBanner card={myCard} areaName={areaName} />

      {modal && <CardModal card={modal === "new" ? null : modal} onSave={(card) => { persist(cards.find((c) => c.id === card.id) ? cards.map((c) => c.id === card.id ? card : c) : [...cards, card]); setModal(null); }} onClose={() => setModal(null)} />}
    </>
  );
}
