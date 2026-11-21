import {
  addEventListener, callable, definePlugin, FileSelectionType, getExternalResourceURL,
  openFilePicker, removeEventListener, toaster, useQuickAccessVisible,
} from "@decky/api";
import {
  ButtonItem, DropdownItem, Focusable, PanelSection, PanelSectionRow, staticClasses,
} from "@decky/ui";
import { useEffect, useRef, useState } from "react";
import { FaBoxOpen } from "react-icons/fa";

type Option = { id: string; nome: string };
type Package = Option & { categoria: string; capa: string };
type Catalog = { categorias: Option[]; pacotes: Package[]; aviso: string };
type Status = "active" | "waiting" | "paused" | "complete" | "error";
type Download = Option & {
  pasta: string;
  estado: Status;
  baixado: number;
  total: number;
  velocidade: number;
  erro: string | null;
  atalho: number | null;
};
type Queue = { downloads: Download[]; aviso: string };
type Tab = "loja" | "downloads";

const getCatalog = callable<[refresh: boolean], Catalog>("get_catalog");
const listDownloads = callable<[], Queue>("list_downloads");
const enqueue = callable<[id: string, folder: string], string>("start_download");
const setPaused = callable<[id: string, pause: boolean], void>("set_paused");
const checkExecutable = callable<[id: string, path: string], string>("check_executable");
const saveShortcut = callable<[id: string, appId: number], void>("save_shortcut");

const labels: Record<Status, string> = {
  active: "Baixando", waiting: "Aguardando", paused: "Pausado",
  complete: "Concluído", error: "Falha no download",
};
const format = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });

function size(bytes: number) {
  if (bytes >= 1024 ** 3) return `${format.format(bytes / 1024 ** 3)} GiB`;
  if (bytes >= 1024 ** 2) return `${format.format(bytes / 1024 ** 2)} MiB`;
  if (bytes >= 1024) return `${format.format(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

function PickerFilter({
  label, options, selected, onChange,
}: {
  label: string; options: Option[]; selected: string; onChange: (value: string) => void;
}) {
  return (
    <PanelSectionRow>
      <DropdownItem
        label={label}
        selectedOption={selected}
        rgOptions={options.map(({ id, nome }) => ({ data: id, label: nome }))}
        onChange={({ data }) => onChange(data)}
      />
    </PanelSectionRow>
  );
}

function Cover({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div style={{
      width: 60, height: 45, flex: "0 0 60px", borderRadius: 4, overflow: "hidden",
      display: "grid", placeItems: "center", background: "#263444", color: "#b7cede",
    }}>
      {src && !failed ? (
        <img
          src={src.startsWith("data:") ? src : getExternalResourceURL(src)}
          alt="" width={60} height={45} loading="lazy"
          style={{ objectFit: "cover" }} onError={() => setFailed(true)}
        />
      ) : <FaBoxOpen aria-hidden />}
    </div>
  );
}

function Content() {
  const visible = useQuickAccessVisible();
  const [home, setHome] = useState("/home/deck");
  const [tab, setTab] = useState<Tab>("loja");
  const [catalog, setCatalog] = useState<Catalog>();
  const [catalogError, setCatalogError] = useState("");
  const [queue, setQueue] = useState<Queue>();
  const [queueError, setQueueError] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const actionInFlight = useRef(false);
  const [error, setError] = useState("");
  const [catalogLimit, setCatalogLimit] = useState(12);
  const [queueLimit, setQueueLimit] = useState(12);
  const [created, setCreated] = useState<Record<string, number>>({});
  const currentCategory = catalog?.categorias.find(({ id }) => id === category);

  useEffect(() => {
    callable<[], string>("home_folder")().then(setHome).catch(() => {});
  }, []);

  useEffect(() => {
    if (!visible) return;
    let current = true;
    setCatalogError("");
    void (async () => {
      try {
        const cached = await getCatalog(false);
        if (current) setCatalog(cached);
        const refreshed = await getCatalog(true);
        if (current) setCatalog(refreshed);
      } catch {
        if (current) setCatalogError("Falha ao carregar a loja. Reabra o painel para tentar novamente.");
      }
    })();
    return () => { current = false; };
  }, [visible]);

  useEffect(() => {
    if (!visible || tab !== "downloads") return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const result = await listDownloads();
        if (current) {
          setQueue(result);
          setQueueError("");
        }
      } catch {
        if (current) setQueueError("Falha ao consultar a fila. Tentando novamente…");
      }
      if (current) timer = setTimeout(refresh, 1500);
    };
    void refresh();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [visible, tab]);

  async function act(action: () => Promise<void>) {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      if (failure !== "User canceled") {
        setError(failure instanceof Error ? failure.message : "Não foi possível concluir a ação.");
      }
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  }

  async function download(entry: Package) {
    const { realpath } = await openFilePicker(FileSelectionType.FOLDER, home, false, true);
    await enqueue(entry.id, realpath);
    setTab("downloads");
  }

  async function shortcut(job: Download) {
    const { realpath } = await openFilePicker(
      FileSelectionType.FILE, job.pasta, true, true, undefined, ["exe"],
    );
    const target = await checkExecutable(job.id, realpath);
    const appId = await SteamClient.Apps.AddShortcut(job.nome, target, "", "");
    if (!appId) throw new Error("A Steam não conseguiu criar o atalho.");
    setCreated((previous) => ({ ...previous, [job.id]: appId }));
    await saveShortcut(job.id, appId);
    SteamClient.Apps.SetShortcutStartDir(appId, target.slice(0, target.lastIndexOf("/")));
    toaster.toast({ title: "Adicionado à Steam", body: job.nome });
  }

  const packages = catalog?.pacotes.filter((entry) =>
    !currentCategory || entry.categoria === currentCategory.id,
  ) ?? [];

  return (
    <>
      <PanelSection>
        <PanelSectionRow>
          <Focusable style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: 8 }}>
            <ButtonItem layout="below" bottomSeparator="none" disabled={tab === "loja"}
              onClick={() => { setError(""); setTab("loja"); }}>Loja</ButtonItem>
            <ButtonItem layout="below" bottomSeparator="none" disabled={tab === "downloads"}
              onClick={() => { setError(""); setTab("downloads"); }}>Meus downloads</ButtonItem>
          </Focusable>
        </PanelSectionRow>
        {error && <p role="alert" style={{ overflowWrap: "anywhere" }}>{error}</p>}
      </PanelSection>

      {tab === "loja" ? (
        <PanelSection>
          <div role="status">{catalogError || catalog?.aviso || (!catalog && "Carregando a loja…")}</div>
          {catalog && (
            <>
              <PickerFilter
                label="Categoria"
                options={[{ id: "", nome: "Todas" }, ...catalog.categorias]}
                selected={currentCategory?.id ?? ""}
                onChange={(value) => { setCategory(value); setCatalogLimit(12); }}
              />
              {packages.length === 0 && <p>Nenhum pacote disponível nesta seleção.</p>}
              {packages.slice(0, catalogLimit).map((entry) => {
                const group = catalog.categorias.find(({ id }) => id === entry.categoria);
                return (
                  <PanelSectionRow key={entry.id}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, paddingBlock: 8 }}>
                      <Cover key={entry.capa} src={entry.capa} />
                      <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                        <strong>{entry.nome}</strong>
                        <div style={{ fontSize: 12, color: "#b7cede" }}>
                          {group?.nome}
                        </div>
                      </div>
                    </div>
                    <ButtonItem layout="below" disabled={busy} onClick={() => act(() => download(entry))}>
                      Baixar
                    </ButtonItem>
                  </PanelSectionRow>
                );
              })}
              {packages.length > catalogLimit && (
                <PanelSectionRow>
                  <ButtonItem layout="below" onClick={() => setCatalogLimit((limit) => limit + 12)}>
                    Mostrar mais pacotes
                  </ButtonItem>
                </PanelSectionRow>
              )}
            </>
          )}
        </PanelSection>
      ) : (
        <PanelSection>
          <div role="status">{queueError || queue?.aviso || (!queue && "Carregando downloads…")}</div>
          {queue?.downloads.length === 0 && <p>Escolha um pacote na Loja para começar.</p>}
          {queue?.downloads.slice(0, queueLimit).map((job) => (
            <PanelSectionRow key={job.id}>
              <div style={{ paddingBlock: 10, overflowWrap: "anywhere" }}>
                <strong>{job.nome}</strong>
                <div>{labels[job.estado]}</div>
                {job.total > 0 && (
                  <>
                    <progress
                      aria-label={`Progresso de ${job.nome}`} value={job.baixado} max={job.total}
                      style={{ width: "100%", height: 6, accentColor: "#77c9ef" }}
                    />
                    <div style={{ fontSize: 12, color: "#b7cede", fontVariantNumeric: "tabular-nums" }}>
                      {size(job.baixado)} / {size(job.total)}
                      {job.estado === "active" && ` · ${size(job.velocidade)}/s`}
                    </div>
                  </>
                )}
                {job.estado === "active" && !job.total && <div>Buscando metadados do torrent…</div>}
                {job.erro && <div>{job.erro}</div>}
              </div>
              {job.estado === "complete" ? (
                <ButtonItem
                  layout="below" disabled={busy || Boolean(job.atalho || created[job.id])}
                  onClick={() => act(() => shortcut(job))}
                >
                  {job.atalho || created[job.id] ? "Adicionado à Steam" : "Adicionar à Steam"}
                </ButtonItem>
              ) : job.estado !== "error" && (
                <ButtonItem layout="below" disabled={busy}
                  onClick={() => act(() => setPaused(job.id, job.estado !== "paused"))}>
                  {job.estado === "paused" ? "Continuar" : "Pausar"}
                </ButtonItem>
              )}
            </PanelSectionRow>
          ))}
          {queue && queue.downloads.length > queueLimit && (
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={() => setQueueLimit((limit) => limit + 12)}>
                Mostrar mais downloads
              </ButtonItem>
            </PanelSectionRow>
          )}
        </PanelSection>
      )}
    </>
  );
}

export default definePlugin(() => {
  const listener = addEventListener<[string]>("download_concluido", (name) =>
    toaster.toast({ title: "Download concluído", body: name }),
  );
  return {
    name: "Catálogo Decky",
    titleView: <div className={staticClasses.Title}>Catálogo Decky</div>,
    content: <Content />,
    icon: <FaBoxOpen />,
    alwaysRender: true,
    onDismount: () => removeEventListener("download_concluido", listener),
  };
});
