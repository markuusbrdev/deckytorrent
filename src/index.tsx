import {
  addEventListener, callable, definePlugin, FileSelectionType, getExternalResourceURL,
  openFilePicker, removeEventListener, routerHook, toaster, useQuickAccessVisible,
} from "@decky/api";
import {
  ConfirmModal, DialogButton, DropdownItem, Focusable, Navigation, showModal, staticClasses, TextField,
} from "@decky/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { FaArrowLeft, FaBoxOpen, FaDownload, FaSearch, FaStore } from "react-icons/fa";
import { styles } from "./styles";

type Option = { id: string; nome: string };
type Package = Option & { categoria: string; capa: string; magnet: string };
type Catalog = { categorias: Option[]; pacotes: Package[]; aviso: string; loja: string; lojaPadrao: string };
type Status = "active" | "waiting" | "paused" | "complete" | "error";
type Download = Option & {
  pasta: string;
  estado: Status;
  baixado: number;
  total: number;
  velocidade: number;
  erro: string | null;
  atalho: number | null;
  temExecutavel: boolean;
  apagando: boolean | null;
};
type Queue = { downloads: Download[]; aviso: string };

const storeRoute = "/decky-torrent/loja";
const downloadsRoute = "/decky-torrent/downloads";
const getCatalog = callable<[refresh: boolean], Catalog>("get_catalog");
const changeStore = callable<[repository: string], Catalog>("change_store");
const getPackageSize = callable<[id: string, magnet: string], number | null>("get_package_size");
const listDownloads = callable<[], Queue>("list_downloads");
const homeFolder = callable<[], string>("home_folder");
const enqueue = callable<[id: string, folder: string, magnet: string], string>("start_download");
const deleteDownload = callable<[id: string, deleteFiles: boolean], void>("delete_download");
const setPaused = callable<[id: string, pause: boolean], void>("set_paused");
const checkExecutable = callable<[id: string, path: string], string>("check_executable");
const saveShortcut = callable<[id: string, appId: number], void>("save_shortcut");
const labels: Record<Status, string> = {
  active: "Baixando", waiting: "Aguardando", paused: "Pausado",
  complete: "Concluído", error: "Falha no download",
};
const format = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });

let catalogRefresh: Promise<Catalog> | undefined;

function refreshCatalog() {
  catalogRefresh ??= getCatalog(true).finally(() => { catalogRefresh = undefined; });
  return catalogRefresh;
}

function size(bytes: number) {
  if (bytes >= 1024 ** 3) return `${format.format(bytes / 1024 ** 3)} GiB`;
  if (bytes >= 1024 ** 2) return `${format.format(bytes / 1024 ** 2)} MiB`;
  if (bytes >= 1024) return `${format.format(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

function openPage(path: string) {
  Navigation.Navigate(path);
  Navigation.CloseSideMenus();
}

function useQueue(enabled: boolean) {
  const [queue, setQueue] = useState<Queue>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const result = await listDownloads();
        if (current) {
          setQueue(result);
          setError("");
        }
      } catch {
        if (current) setError("Falha ao consultar a fila. Tentando novamente…");
      }
      if (current) timer = setTimeout(refresh, 1500);
    };
    void refresh();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [enabled]);
  return { queue, status: error || queue?.aviso || (!queue ? "Carregando downloads…" : "") };
}

function useAction() {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      if (failure !== "User canceled") {
        const message = failure instanceof Error ? failure.message : failure;
        setError(typeof message === "string" ? message : "Não foi possível concluir a ação.");
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return { run, busy, error, clearError: () => setError("") };
}

function Cover({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="dt-cover">
      {src && !failed ? (
        <img
          src={src.startsWith("data:") ? src : getExternalResourceURL(src)}
          alt="" loading="lazy" onError={() => setFailed(true)}
        />
      ) : <FaBoxOpen aria-hidden />}
    </div>
  );
}

function CatalogCard({ entry, disabled, download }: {
  entry: Package;
  disabled: boolean;
  download: () => void;
}) {
  const [bytes, setBytes] = useState<number | null>();
  useEffect(() => {
    let current = true;
    void getPackageSize(entry.id, entry.magnet).then(
      (result) => { if (current) setBytes(result); },
      () => { if (current) setBytes(null); },
    );
    return () => { current = false; };
  }, [entry.id, entry.magnet]);

  return (
    <DialogButton
      className="dt-card"
      noFocusRing
      disabled={disabled}
      onClick={download}
    >
      <Cover key={entry.capa} src={entry.capa} />
      <span className="dt-card-copy">
        <span className="dt-sr-only">Baixar </span>
        <strong>{entry.nome}</strong>
        <span className="dt-card-size">
          {bytes === undefined ? "Consultando tamanho…" : bytes === null ? "Tamanho indisponível" : size(bytes)}
        </span>
      </span>
    </DialogButton>
  );
}

function Page({ title, children, toolbar }: { title: string; children: ReactNode; toolbar?: ReactNode }) {
  return (
    <Focusable className="dt-page">
      <style>{styles}</style>
      <main className="dt-page-inner" aria-label={title}>
        <Focusable className="dt-header" flow-children="right">
          <div>
            <DialogButton className="dt-back" onClick={() => Navigation.NavigateBack()}>
              <span className="dt-button-content"><FaArrowLeft aria-hidden /> Voltar</span>
            </DialogButton>
            <h1>{title}</h1>
          </div>
          {toolbar}
        </Focusable>
        {children}
      </main>
    </Focusable>
  );
}

function PluginTitle() {
  return (
    <Focusable className={`${staticClasses.Title} dt-plugin-title`} flow-children="right">
      <style>{styles}</style>
      <span className="dt-plugin-name">Decky Torrent</span>
      <DialogButton className="dt-nav-button" onClick={() => openPage(storeRoute)} onOKActionDescription="Loja">
        <FaStore aria-hidden />
        <span className="dt-sr-only">Loja</span>
      </DialogButton>
      <DialogButton className="dt-nav-button" onClick={() => openPage(downloadsRoute)} onOKActionDescription="Downloads">
        <FaDownload aria-hidden />
        <span className="dt-sr-only">Downloads</span>
      </DialogButton>
    </Focusable>
  );
}

function Home() {
  const visible = useQuickAccessVisible();
  const { queue, status } = useQueue(visible);
  const action = useAction();
  const [created, setCreated] = useState<Record<string, number>>({});
  const [limit, setLimit] = useState(12);

  useEffect(() => {
    if (visible) void refreshCatalog().catch(() => {});
  }, [visible]);

  async function shortcut(job: Download) {
    const { realpath } = await openFilePicker(FileSelectionType.FILE, job.pasta, true, true, undefined, ["exe"]);
    const target = await checkExecutable(job.id, realpath);
    const appId = await SteamClient.Apps.AddShortcut(job.nome, target, "", "");
    if (!appId) throw new Error("A Steam não conseguiu criar o atalho.");
    setCreated((previous) => ({ ...previous, [job.id]: appId }));
    await saveShortcut(job.id, appId);
    SteamClient.Apps.SetShortcutStartDir(appId, target.slice(0, target.lastIndexOf("/")));
    toaster.toast({ title: "Adicionado à Steam", body: job.nome });
  }

  const ready = queue?.downloads.filter((job) =>
    job.estado === "complete" && job.temExecutavel && !job.atalho && !created[job.id],
  );

  return (
    <Focusable className="dt-home">
      <h2>Prontos para adicionar</h2>
      {status && <p className="dt-status" role="status">{status}</p>}
      {action.error && <p className="dt-error" role="alert">{action.error}</p>}
      {ready?.length === 0 && <p className="dt-muted">Os downloads concluídos com um .exe aparecem aqui.</p>}
      {ready?.slice(0, limit).map((job) => (
        <Focusable key={job.id} className="dt-ready">
          <strong>{job.nome}</strong>
          <div className="dt-ready-meta">
            <div>Tamanho total · {size(job.total)}</div>
            <div className="dt-path">{job.pasta}</div>
          </div>
          <DialogButton disabled={action.busy} onClick={() => action.run(() => shortcut(job))}>
            Adicionar à Steam
          </DialogButton>
        </Focusable>
      ))}
      {ready && ready.length > limit && (
        <DialogButton onClick={() => setLimit((previous) => previous + 12)}>Mostrar mais</DialogButton>
      )}
    </Focusable>
  );
}

function searchText(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLocaleLowerCase("pt-BR");
}

function StorePage() {
  const [catalog, setCatalog] = useState<Catalog>();
  const [error, setError] = useState("");
  const [storeOpen, setStoreOpen] = useState(false);
  const [repositoryDraft, setRepositoryDraft] = useState("");
  const storeRevision = useRef(0);
  const storeAction = useAction();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [limit, setLimit] = useState(12);
  const action = useAction();

  useEffect(() => {
    let mounted = true;
    const revision = storeRevision.current;
    const current = () => mounted && storeRevision.current === revision;
    void (async () => {
      try {
        const cached = await getCatalog(false);
        if (current()) setCatalog(cached);
      } catch {
        if (current()) setError("Falha ao carregar o catálogo salvo.");
      }
      try {
        const refreshed = await refreshCatalog();
        if (current()) {
          setCatalog(refreshed);
          setError("");
        }
      } catch {
        if (current()) setError("Falha ao atualizar a Loja. Reabra esta tela para tentar novamente.");
      }
    })();
    return () => { mounted = false; };
  }, []);

  async function download(entry: Package) {
    const home = await homeFolder().catch(() => "/home/deck");
    const { realpath } = await openFilePicker(FileSelectionType.FOLDER, home, false, true);
    await enqueue(entry.id, realpath, entry.magnet);
    openPage(downloadsRoute);
  }

  function selectStore(repository: string) {
    void storeAction.run(async () => {
      const next = await changeStore(repository);
      storeRevision.current += 1;
      setCatalog(next);
      setCategory("");
      setQuery("");
      setSearchOpen(false);
      setLimit(12);
      setError("");
      setStoreOpen(false);
      toaster.toast({ title: "Loja alterada", body: next.loja });
    });
  }

  const selected = catalog?.categorias.some(({ id }) => id === category) ? category : "";
  const term = searchText(query);
  const packages = catalog?.pacotes.filter((entry) =>
    (!selected || entry.categoria === selected) && (!term || searchText(entry.nome).includes(term)),
  );
  const status = error || catalog?.aviso || (!catalog ? "Carregando a Loja…" : "");

  return (
    <Page
      title="Loja"
      toolbar={
        <Focusable className="dt-store-tools" flow-children="right">
          <DialogButton
            className="dt-search-toggle"
            disabled={storeAction.busy || action.busy}
            onClick={() => {
              storeAction.clearError();
              setRepositoryDraft(catalog?.loja ?? "");
              setStoreOpen(!storeOpen);
            }}
          >
            Trocar de loja
          </DialogButton>
          <DialogButton
            className="dt-search-toggle"
            onClick={() => {
              setSearchOpen(!searchOpen);
              if (searchOpen) setQuery("");
              setLimit(12);
            }}
          >
            <span className="dt-button-content">
              <FaSearch aria-hidden /> {searchOpen ? "Fechar pesquisa" : "Pesquisar"}
            </span>
          </DialogButton>
          {catalog && (
            <div className="dt-filter">
              <DropdownItem
                label="Categoria"
                selectedOption={selected}
                rgOptions={[{ data: "", label: "Todas" }, ...catalog.categorias.map(({ id, nome }) => ({ data: id, label: nome }))]}
                onChange={({ data }) => { setCategory(data); setLimit(12); }}
              />
            </div>
          )}
        </Focusable>
      }
    >
      {storeOpen && (
        <Focusable className="dt-store-form">
          <TextField
            label="Repositório da loja"
            description="Use um repositório público do GitHub com catalogo.json na raiz."
            value={repositoryDraft}
            disabled={storeAction.busy}
            focusOnMount
            onChange={(event) => setRepositoryDraft(event.currentTarget.value)}
          />
          {storeAction.error && <p className="dt-error" role="alert">{storeAction.error}</p>}
          <Focusable className="dt-store-tools" flow-children="right">
            <DialogButton
              className="dt-search-toggle"
              disabled={storeAction.busy || !repositoryDraft.trim()}
              onClick={() => selectStore(repositoryDraft)}
            >
              {storeAction.busy ? "Verificando loja…" : "Salvar loja"}
            </DialogButton>
            {catalog?.lojaPadrao && catalog.loja !== catalog.lojaPadrao && (
              <DialogButton className="dt-search-toggle" disabled={storeAction.busy}
                onClick={() => selectStore(catalog.lojaPadrao)}>
                Usar loja padrão
              </DialogButton>
            )}
            <DialogButton className="dt-search-toggle" disabled={storeAction.busy}
              onClick={() => setStoreOpen(false)}>
              Cancelar
            </DialogButton>
          </Focusable>
        </Focusable>
      )}
      {searchOpen && (
        <div className="dt-search">
          <TextField
            label="Pesquisar por título"
            value={query}
            focusOnMount
            bShowClearAction
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setLimit(12);
            }}
          />
        </div>
      )}
      <p className="dt-status" role="status">{status}</p>
      {action.error && <p className="dt-error" role="alert">{action.error}</p>}
      {packages?.length === 0 && (
        <p className="dt-empty" role="status">
          {term ? "Nenhum título encontrado." : selected ? "Nenhum pacote nesta categoria." : "Nenhum pacote disponível na Loja."}
        </p>
      )}
      {packages && packages.length > 0 && (
        <Focusable className="dt-grid">
          {packages.slice(0, limit).map((entry) => (
            <CatalogCard
              key={`${catalog?.loja}:${entry.id}:${entry.magnet}`}
              entry={entry}
              disabled={action.busy || storeAction.busy}
              download={() => action.run(() => download(entry))}
            />
          ))}
        </Focusable>
      )}
      {packages && packages.length > limit && (
        <DialogButton className="dt-more" onClick={() => setLimit((previous) => previous + 12)}>
          Mostrar mais pacotes
        </DialogButton>
      )}
    </Page>
  );
}

function DownloadsPage() {
  const { queue, status } = useQueue(true);
  const action = useAction();
  const [limit, setLimit] = useState(12);

  function confirmDelete(job: Download) {
    const deleteFiles = job.estado !== "complete";
    const modal = showModal(
      <ConfirmModal
        strTitle={`Apagar ${job.nome}?`}
        strOKButtonText="Apagar"
        strCancelButtonText="Cancelar"
        bDestructiveWarning={deleteFiles}
        onCancel={() => modal.Close()}
        onOK={() => {
          modal.Close();
          void action.run(async () => {
            await deleteDownload(job.id, deleteFiles);
            toaster.toast({ title: "Download removido", body: job.nome });
          });
        }}
      >
        {deleteFiles ? (
          <div>
            A transferência será cancelada e a pasta abaixo, incluindo os arquivos já baixados, será excluída.
            <div className="dt-delete-path">{job.pasta}</div>
          </div>
        ) : "O download será removido da lista. Os arquivos e qualquer atalho na Steam serão mantidos."}
      </ConfirmModal>,
    );
  }

  return (
    <Page title="Downloads">
      <p className="dt-status" role="status">{status}</p>
      {action.error && <p className="dt-error" role="alert">{action.error}</p>}
      {queue?.downloads.length === 0 && <p className="dt-empty">Escolha um pacote na Loja para começar.</p>}
      <Focusable className="dt-transfers">
        {queue?.downloads.slice(0, limit).map((job) => (
          <Focusable key={job.id} className="dt-transfer" flow-children="right">
            <div className="dt-transfer-body">
              <div className="dt-transfer-heading">
                <strong>{job.nome}</strong>
                <span className="dt-state">
                  {job.apagando ? "Exclusão pendente" : job.atalho ? "Adicionado à Steam" : labels[job.estado]}
                </span>
              </div>
              {job.total > 0 && (
                <>
                  <progress aria-label={`Progresso de ${job.nome}`} value={job.baixado} max={job.total} />
                  <div className="dt-transfer-meta">
                    <span>{size(job.baixado)} / {size(job.total)}</span>
                    {job.estado === "active" && <span>{size(job.velocidade)}/s</span>}
                  </div>
                </>
              )}
              {job.estado === "active" && !job.total && <div className="dt-muted">Buscando metadados do torrent…</div>}
              {job.estado === "complete" && job.temExecutavel && !job.atalho && (
                <div className="dt-muted">Pronto para adicionar à Steam pelo painel do Decky Torrent.</div>
              )}
              {job.erro && <div className="dt-error">{job.erro}</div>}
            </div>
            <Focusable className="dt-transfer-actions" flow-children="right">
              {job.estado !== "complete" && job.estado !== "error" && !job.apagando && (
                <DialogButton className="dt-transfer-action" disabled={action.busy}
                  onClick={() => action.run(() => setPaused(job.id, job.estado !== "paused"))}>
                  {job.estado === "paused" ? "Continuar" : "Pausar"}
                </DialogButton>
              )}
              <DialogButton className="dt-transfer-action dt-delete" disabled={action.busy}
                onClick={() => confirmDelete(job)}>
                Apagar
              </DialogButton>
            </Focusable>
          </Focusable>
        ))}
      </Focusable>
      {queue && queue.downloads.length > limit && (
        <DialogButton className="dt-more" onClick={() => setLimit((previous) => previous + 12)}>
          Mostrar mais downloads
        </DialogButton>
      )}
    </Page>
  );
}

export default definePlugin(() => {
  routerHook.addRoute(storeRoute, StorePage);
  routerHook.addRoute(downloadsRoute, DownloadsPage);
  const listener = addEventListener<[string]>("download_concluido", (name) =>
    toaster.toast({ title: "Download concluído", body: name }),
  );
  return {
    name: "Decky Torrent",
    titleView: <PluginTitle />,
    content: <Home />,
    icon: <FaStore />,
    alwaysRender: true,
    onDismount() {
      removeEventListener("download_concluido", listener);
      routerHook.removeRoute(storeRoute);
      routerHook.removeRoute(downloadsRoute);
    },
  };
});
