"use strict";

const $ = (id) => document.getElementById(id);
const MiB = 1024 ** 2;
const idPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const coverPattern = /^imagens\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(png|jpe?g|webp)$/;
const encoder = new TextEncoder();
const catalogText = (data) => JSON.stringify(data, null, 2) + "\n";
const covers = new Map();
const snapshotName = "editor/catalogo-local.js";
const snapshotText = (text) => `globalThis.deckyCatalog = ${text.trim()};\n`;
const form = $("package-form");
let catalog = { categorias: [], pacotes: [] };
let selected = "";
let dirty = false;
let draft = false;
let previewUrl;
let exporting = false;
let busy = false;
let project;
let directMode = false;
let localPreviews = false;
let suggestedFile;
let coverTimer;
let coverSearch;
let coverPick = 0;
let diskText;
const supportsFolder = typeof window.showDirectoryPicker === "function";

function validName(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 150;
}

function validMagnet(value) {
  if (typeof value !== "string" || value.length > 8192 || !/^magnet:\?/i.test(value)) return false;
  const hashes = new URLSearchParams(value.slice(8).split("#")[0]).getAll("xt");
  return hashes.length === 1 && /^urn:btih:(?:[0-9a-fA-F]{40}|[a-zA-Z2-7]{32})$/.test(hashes[0]);
}

function validate(data) {
  const categories = new Set();
  if (!Array.isArray(data?.categorias) || !Array.isArray(data?.pacotes)) {
    throw new Error("O JSON precisa conter as listas categorias e pacotes.");
  }
  for (const category of data.categorias) {
    const { id, nome } = category ?? {};
    if (typeof id !== "string" || !idPattern.test(id) || !validName(nome) || categories.has(id)) {
      throw new Error("Há uma categoria inválida ou repetida.");
    }
    categories.add(id);
  }
  const ids = new Set();
  for (const entry of data.pacotes) {
    const { id, nome, magnet, categoria, imagem } = entry ?? {};
    if (typeof id !== "string" || !idPattern.test(id) || ids.has(id) ||
        !validName(nome) || !validMagnet(magnet) || !categories.has(categoria) ||
        typeof imagem !== "string" || !coverPattern.test(imagem)) {
      throw new Error(`Revise o pacote ${typeof nome === "string" ? nome : "sem nome"} no JSON.`);
    }
    ids.add(id);
  }
}

function parseCatalog(text) {
  const data = JSON.parse(text);
  validate(data);
  data.categorias.forEach((category) => { delete category.subcategorias; });
  data.pacotes.forEach((entry) => { delete entry.subcategoria; });
  return data;
}

function refreshStorageMode() {
  $("storage-mode").textContent = directMode
    ? "Gravação automática nos arquivos do projeto."
    : project
    ? `Gravação direta na pasta ${project.name}`
    : supportsFolder
      ? "Vincule a pasta uma vez para autorizar a gravação direta."
      : "Use Chrome ou Edge para gravar direto na pasta. Neste navegador, exporte o ZIP.";
  $("link-folder").hidden = directMode || !supportsFolder;
  $("link-folder").textContent = project ? "Trocar pasta do projeto" : "Vincular pasta do projeto";
}

async function fileHandle(folder, path, create = false) {
  const parts = path.split("/");
  const filename = parts.pop();
  for (const part of parts) folder = await folder.getDirectoryHandle(part, { create });
  return folder.getFileHandle(filename, { create });
}

function projectAccess(mode, visit) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("decky-catalog-editor", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("projects");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("projects", mode);
      let result;
      try {
        result = visit(transaction.objectStore("projects"), location.pathname);
      } catch (failure) {
        transaction.abort();
        database.close();
        reject(failure);
        return;
      }
      transaction.oncomplete = () => { database.close(); resolve(result.result); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  });
}

function savedCatalogAccess(mode, visit) {
  return projectAccess(mode, (store, key) => visit(store, [key, "catalog"]));
}

function persistCatalog(data, imagePath, image) {
  const files = new Map([...covers].map(([path, cover]) => [path, cover.file]));
  if (image) files.set(imagePath, image);
  const used = new Set(data.pacotes.map(({ imagem }) => imagem));
  const images = [...files].filter(([path]) => used.has(path));
  return savedCatalogAccess("readwrite", (store, key) =>
    store.put({ data, images, localPreviews }, key),
  );
}

function clearSavedCatalog() {
  return savedCatalogAccess("readwrite", (store, key) => store.delete(key));
}

async function availableCoverPath(id, extension, used) {
  for (let suffix = 1; ; suffix++) {
    const path = `imagens/${id}${suffix === 1 ? "" : "-" + suffix}.${extension}`;
    if (used.has(path)) continue;
    if (directMode) {
      const response = await fetch(`../${path}`, { method: "HEAD" });
      if (response.status === 404) return path;
      if (!response.ok) throw new Error("Não foi possível verificar a pasta de capas.");
      continue;
    }
    if (!project) return path;
    try {
      await fileHandle(project, path);
    } catch (failure) {
      if (failure.name === "NotFoundError") return path;
      if (failure.name !== "TypeMismatchError") throw failure;
    }
  }
}

async function writeFile(handle, data) {
  const writer = await handle.createWritable({ mode: "exclusive" });
  try {
    await writer.write(data);
    await writer.close();
  } catch (failure) {
    await writer.abort().catch(() => {});
    throw failure;
  }
}

async function readCatalog(handle) {
  const file = await handle.getFile();
  if (file.size > MiB) throw new Error("O JSON deve ter até 1 MiB.");
  return file.text();
}

async function saveToProject(text, imagePath, image) {
  let capa;
  if (image) {
    const bytes = new Uint8Array(await image.arrayBuffer());
    let data = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      data += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    capa = { caminho: imagePath, dados: btoa(data) };
  }
  const response = await fetch("/api/catalogo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ anterior: diskText, catalogo: text, capa }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.erro || "Não foi possível gravar o catálogo.");
  diskText = text;
  if (result.aviso) $("storage-mode").textContent = result.aviso;
}

async function store(next, imagePath, image) {
  const text = catalogText(next);
  if (encoder.encode(text).length > MiB) throw new Error("O catálogo atingiu o limite de 1 MiB.");
  if (directMode) {
    await saveToProject(text, imagePath, image);
  } else if (project) {
    const handle = await project.getFileHandle("catalogo.json");
    if (await readCatalog(handle) !== diskText) {
      throw new Error("O catalogo.json mudou fora do editor. Vincule a pasta novamente antes de gravar.");
    }
    try {
      if (image) await writeFile(await fileHandle(project, imagePath, true), image);
      await writeFile(handle, text);
    } catch {
      throw new Error("Falha ao gravar na pasta. Confira a permissão de escrita e tente salvar novamente.");
    }
    diskText = text;
    try {
      await writeFile(await fileHandle(project, snapshotName, true), snapshotText(text));
    } catch {
      $("storage-mode").textContent = "Catálogo gravado. A cópia de abertura automática não pôde ser atualizada.";
    }
  } else {
    try {
      await persistCatalog(next, imagePath, image);
    } catch {
      throw new Error("O navegador não conseguiu guardar o catálogo. Vincule a pasta do projeto para salvar.");
    }
  }
  if (image) keepCover(imagePath, image);
  catalog = next;
  dirty = !project && !directMode;
}

function loadCatalog(next, nextProject, text, images = [], useLocalImages = false) {
  for (const cover of covers.values()) URL.revokeObjectURL(cover.url);
  covers.clear();
  for (const [path, file] of images) keepCover(path, file);
  catalog = next;
  localPreviews = useLocalImages;
  project = nextProject;
  diskText = text;
  dirty = false;
  refreshStorageMode();
  fillForm();
}

async function projectCovers(folder, data) {
  const images = [];
  for (const path of new Set(data.pacotes.map(({ imagem }) => imagem))) {
    try {
      const file = await (await fileHandle(folder, path)).getFile();
      if (file.size <= MiB) images.push([path, file]);
    } catch {
      // An unavailable cover can still be replaced in the editor.
    }
  }
  return images;
}

$("link-folder").addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  try {
    const folder = await window.showDirectoryPicker({ mode: "readwrite", id: "decky-catalogo" });
    let handle;
    try {
      handle = await folder.getFileHandle("catalogo.json");
    } catch (failure) {
      if (failure.name !== "NotFoundError") throw failure;
      throw new Error("Selecione a raiz do projeto, onde está o catalogo.json.");
    }
    const text = await readCatalog(handle);
    const next = parseCatalog(text);
    if ((dirty || draft) && !await ask("Substituir catálogo?", "As alterações pendentes na página serão descartadas.", "Vincular pasta")) return;
    const images = await projectCovers(folder, next);
    await clearSavedCatalog().catch(() => {});
    loadCatalog(next, folder, text, images);
    await projectAccess("readwrite", (store, key) => store.put(folder, key)).catch(() => {});
    try {
      await writeFile(await fileHandle(folder, snapshotName, true), snapshotText(text));
    } catch {
      // Saving the catalog still works if the editor folder cannot be written.
    }
    notice("Pasta vinculada. As alterações serão gravadas no projeto ao salvar.");
  } catch (failure) {
    if (failure.name !== "AbortError") notice(failure instanceof SyntaxError ? "O catalogo.json da pasta é inválido." : failure.message);
  } finally {
    busy = false;
  }
});

function makeId(name, siblings) {
  const base = name.normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 54) || "item";
  let candidate = base;
  let index = 2;
  while (siblings.some((item) => item.id === candidate)) candidate = `${base}-${index++}`;
  return candidate;
}

function choices(select, entries, empty, value = "") {
  select.replaceChildren(new Option(empty, ""), ...entries.map(({ id, nome }) => new Option(nome, id)));
  select.value = entries.some(({ id }) => id === value) ? value : "";
}

function notice(message) {
  $("notice").textContent = message;
}

function error(messageId, field, message) {
  $(messageId).textContent = message;
  if (field) {
    $(field).setAttribute("aria-invalid", "true");
    $(field).focus();
  }
}

function clearErrors(container, messageId) {
  container.querySelectorAll("[aria-invalid]").forEach((field) => field.removeAttribute("aria-invalid"));
  $(messageId).textContent = "";
}

function ask(title, message, action) {
  const dialog = $("confirm-dialog");
  $("confirm-title").textContent = title;
  $("confirm-body").textContent = message;
  $("confirm-action").textContent = action;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener(
    "close", () => resolve(dialog.returnValue === "ok"), { once: true },
  ));
}

function chosenCover() {
  return $("cover").files[0] ?? suggestedFile;
}

function coverUrl(path) {
  return covers.get(path)?.url || (localPreviews && path ? `../${path}` : "");
}

function stopCoverSearch() {
  clearTimeout(coverTimer);
  coverSearch?.abort();
  $("cover-suggestions").replaceChildren();
  $("cover-search-status").textContent = "";
}

async function wikidata(params, signal) {
  const url = new URL("https://www.wikidata.org/w/api.php");
  url.search = new URLSearchParams({ ...params, format: "json", origin: "*" });
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("Busca de capas indisponível.");
  return response.json();
}

async function suggestCovers(title, signal) {
  const results = await wikidata({
    action: "wbsearchentities", search: title, language: "en", limit: 6,
  }, signal);
  if (!results.search?.length) return [];
  const { entities } = await wikidata({
    action: "wbgetentities", ids: results.search.map(({ id }) => id).join("|"), props: "claims",
  }, signal);
  const seen = new Set();
  const matches = results.search.flatMap(({ id, label }) => {
    const claims = entities?.[id]?.claims?.P1733 ?? [];
    const app = claims.find(({ rank, mainsnak }) =>
      rank !== "deprecated" && /^[1-9][0-9]{0,11}$/.test(mainsnak?.datavalue?.value ?? ""),
    )?.mainsnak.datavalue.value;
    if (!app || seen.has(app)) return [];
    seen.add(app);
    return [{ label, app }];
  }).slice(0, 4);
  return Promise.all(matches.map(async ({ label, app }) => ({
    label, url: await steamCoverUrl(app, signal),
  })));
}

async function steamCoverUrl(app, signal) {
  const base = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${app}/`;
  try {
    const response = await fetch(`https://api.steamcmd.net/v1/info/${app}`, { signal });
    if (response.ok) {
      const { data } = await response.json();
      const capsule = data?.[app]?.common?.library_assets_full?.library_capsule;
      const filename = capsule?.image2x?.english ?? capsule?.image?.english;
      if (typeof filename === "string" && /^(?:[a-f0-9]{40}\/)?[a-z0-9_]+\.(?:jpg|png|webp)$/i.test(filename)) {
        return base + filename;
      }
    }
  } catch {
    // Older releases can still use the unversioned capsule path.
  }
  return base + "library_600x900.jpg";
}

async function useSuggestedCover(url, signal) {
  const request = ++coverPick;
  const status = $("cover-search-status");
  status.textContent = "Carregando capa…";
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error();
    const blob = await response.blob();
    if (!blob.type.startsWith("image/") || signal.aborted) throw new Error();
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 900 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const cover = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.88));
      if (signal.aborted || request !== coverPick) return;
      if (!cover || cover.size > MiB) throw new Error();
      suggestedFile = new File([cover], "capa.webp", { type: cover.type });
    } finally {
      bitmap.close();
    }
    $("cover").value = "";
    $("cover").removeAttribute("aria-invalid");
    draft = true;
    paintCover();
    status.textContent = "Capa selecionada. Salve o pacote para aplicá-la.";
  } catch {
    if (!signal.aborted && request === coverPick) status.textContent = "Não foi possível usar essa capa. Escolha outra ou envie um arquivo.";
  }
}

function scheduleCoverSearch() {
  stopCoverSearch();
  const title = $("name").value.trim();
  if (title.length < 3) return;
  coverSearch = new AbortController();
  const { signal } = coverSearch;
  coverTimer = setTimeout(async () => {
    const status = $("cover-search-status");
    status.textContent = "Buscando capas na Steam…";
    try {
      const results = await suggestCovers(title, signal);
      if (signal.aborted) return;
      status.textContent = results.length ? "Selecione uma capa da Steam" : "Nenhuma capa encontrada. Você pode enviar um arquivo.";
      for (const { label, url } of results) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "cover-suggestion";
        const image = document.createElement("img");
        image.src = url;
        image.alt = "";
        image.addEventListener("error", () => {
          button.remove();
          if (!signal.aborted && !$("cover-suggestions").childElementCount) {
            status.textContent = "Nenhuma capa disponível. Você pode enviar um arquivo.";
          }
        }, { once: true });
        button.append(image, label);
        button.addEventListener("click", () => useSuggestedCover(url, signal));
        $("cover-suggestions").append(button);
      }
    } catch {
      if (!signal.aborted) status.textContent = "Busca de capas indisponível. Você pode enviar um arquivo.";
    }
  }, 450);
}

function paintCover() {
  const saved = catalog.pacotes.find(({ id }) => id === selected);
  const chosen = chosenCover();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = chosen?.size <= MiB ? URL.createObjectURL(chosen) : undefined;
  const url = previewUrl || coverUrl(saved?.imagem);
  const preview = $("preview-image");
  preview.hidden = !url;
  $("preview-text").hidden = Boolean(url);
  $("preview-text").textContent = saved ? "Capa no catálogo" : "Sem capa";
  if (url) preview.src = url;
  else preview.removeAttribute("src");
}

function keepCover(path, file) {
  if (covers.has(path)) URL.revokeObjectURL(covers.get(path).url);
  covers.set(path, { file, url: URL.createObjectURL(file) });
}

function renderList() {
  const list = $("package-list");
  list.replaceChildren();
  $("empty").hidden = catalog.pacotes.length !== 0;
  $("count").textContent = catalog.pacotes.length === 1 ? "1 pacote" : `${catalog.pacotes.length} pacotes`;
  for (const entry of catalog.pacotes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "package-row";
    button.setAttribute("aria-current", String(entry.id === selected));
    const thumb = document.createElement("span");
    thumb.className = "thumbnail";
    thumb.setAttribute("aria-hidden", "true");
    const cover = coverUrl(entry.imagem);
    if (cover) {
      const image = document.createElement("img");
      image.src = cover;
      image.alt = "";
      image.loading = "lazy";
      image.addEventListener("error", () => { thumb.textContent = "—"; }, { once: true });
      thumb.append(image);
    } else {
      thumb.textContent = "—";
    }
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = entry.nome;
    const path = document.createElement("small");
    const category = catalog.categorias.find(({ id }) => id === entry.categoria);
    path.textContent = category.nome;
    copy.append(title, path);
    button.append(thumb, copy);
    button.addEventListener("click", () => openPackage(entry));
    list.append(button);
  }
}

function fillForm(entry) {
  form.reset();
  stopCoverSearch();
  suggestedFile = undefined;
  clearErrors(form, "form-error");
  selected = entry?.id ?? "";
  draft = false;
  $("form-title").textContent = entry ? "Editar pacote" : "Novo pacote";
  $("name").value = entry?.nome ?? "";
  $("magnet").value = entry?.magnet ?? "";
  choices($("category"), catalog.categorias, "Selecione", entry?.categoria);
  $("remove").hidden = !entry;
  paintCover();
  renderList();
}

async function openPackage(entry) {
  if (busy) return;
  if (entry?.id === selected) {
    $("name").focus();
    return;
  }
  if (draft && !await ask("Descartar edição?", "As alterações neste formulário ainda precisam ser salvas.", "Descartar")) return;
  fillForm(entry);
  $("name").focus();
}

$("new").addEventListener("click", () => openPackage());
form.addEventListener("input", (event) => {
  draft = true;
  event.target.removeAttribute("aria-invalid");
});
$("name").addEventListener("input", (event) => {
  if (suggestedFile) {
    suggestedFile = undefined;
    paintCover();
  }
  if (!event.isComposing) scheduleCoverSearch();
});
$("name").addEventListener("compositionstart", stopCoverSearch);
$("name").addEventListener("compositionend", scheduleCoverSearch);
$("cover").addEventListener("change", () => {
  stopCoverSearch();
  suggestedFile = undefined;
  paintCover();
});
$("preview-image").addEventListener("error", () => {
  $("preview-image").hidden = true;
  $("preview-text").hidden = false;
  $("preview-text").textContent = "Prévia indisponível";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  clearErrors(form, "form-error");
  const nome = $("name").value.trim();
  const magnet = $("magnet").value.trim();
  const categoria = $("category").value;
  const prior = catalog.pacotes.find(({ id }) => id === selected);
  const file = chosenCover();
  if (!validName(nome)) return error("form-error", "name", "Informe o nome do pacote.");
  if (!validMagnet(magnet)) return error("form-error", "magnet", "Informe um magnet BitTorrent v1 com um hash válido.");
  if (!categoria) return error("form-error", "category", "Selecione uma categoria ou adicione uma nova.");
  if (!prior && !file) return error("form-error", "cover", "Escolha uma capa para o pacote.");

  const id = prior?.id ?? makeId(nome, catalog.pacotes);
  let imagem = prior?.imagem;
  busy = true;
  form.inert = true;
  try {
    if (file) {
      const extension = file.name.toLowerCase().match(/\.(png|jpe?g|webp)$/)?.[1];
      if (!extension || file.size > MiB) {
        form.inert = false;
        return error("form-error", "cover", "Escolha um PNG, JPEG ou WebP de até 1 MiB.");
      }
      try {
        const bitmap = await createImageBitmap(file);
        bitmap.close();
      } catch {
        form.inert = false;
        return error("form-error", "cover", "Não foi possível abrir a imagem. Escolha outra capa.");
      }
      const used = new Set(catalog.pacotes.filter((entry) => entry !== prior || project || directMode).map((entry) => entry.imagem));
      imagem = await availableCoverPath(id, extension, used);
    }
    const entry = { ...prior, id, nome, magnet, categoria, imagem };
    const pacotes = prior ? catalog.pacotes.map((item) => item === prior ? entry : item) : [...catalog.pacotes, entry];
    await store({ ...catalog, pacotes }, imagem, file);
    form.inert = false;
    fillForm(entry);
    notice(project || directMode ? `${entry.nome} gravado no projeto.` : `${entry.nome} salvo neste navegador. Exporte o ZIP para gravar no projeto.`);
    $("name").focus();
  } catch (failure) {
    error("form-error", null, failure.message);
  } finally {
    form.inert = false;
    busy = false;
  }
});

$("remove").addEventListener("click", async () => {
  if (busy) return;
  const entry = catalog.pacotes.find(({ id }) => id === selected);
  if (!entry) return;
  busy = true;
  try {
    if (!await ask("Remover pacote?", `${entry.nome} sairá do catálogo.`, "Remover pacote")) return;
    const pacotes = catalog.pacotes.filter(({ id }) => id !== entry.id);
    await store({ ...catalog, pacotes });
    fillForm();
    $("new").focus();
    notice(project || directMode ? "Pacote removido do catálogo no projeto." : "Pacote removido do catálogo na página.");
  } catch (failure) {
    error("form-error", null, failure.message);
  } finally {
    busy = false;
  }
});

const taxonomyDialog = $("taxonomy-dialog");
const taxonomyForm = $("taxonomy-form");

$("taxonomy").addEventListener("click", () => {
  if (busy) return;
  taxonomyForm.reset();
  clearErrors(taxonomyForm, "taxonomy-error");
  taxonomyDialog.showModal();
});
taxonomyForm.querySelector("[data-close]").addEventListener("click", () => taxonomyDialog.close());
taxonomyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  clearErrors(taxonomyForm, "taxonomy-error");
  const name = $("category-name").value.trim();
  if (!validName(name)) return error("taxonomy-error", "category-name", "Informe o nome da categoria.");
  if (catalog.categorias.some(({ nome }) => nome.localeCompare(name, "pt-BR", { sensitivity: "base" }) === 0)) {
    return error("taxonomy-error", "category-name", "Essa categoria já existe.");
  }
  const category = { id: makeId(name, catalog.categorias), nome: name };
  const currentCategory = $("category").value;
  busy = true;
  try {
    await store({ ...catalog, categorias: [...catalog.categorias, category] });
    choices($("category"), catalog.categorias, "Selecione", currentCategory || category.id);
    taxonomyDialog.close();
    notice(project || directMode ? `Categoria ${category.nome} gravada no projeto.` : `Categoria ${category.nome} criada.`);
  } catch (failure) {
    error("taxonomy-error", null, failure.message);
  } finally {
    busy = false;
  }
});

$("import").addEventListener("click", () => {
  if (!busy) $("json-file").click();
});
$("json-file").addEventListener("change", async () => {
  const file = $("json-file").files[0];
  $("json-file").value = "";
  if (!file || busy) return;
  busy = true;
  try {
    if (file.size > MiB) throw new Error("O JSON deve ter até 1 MiB.");
    const next = parseCatalog(await file.text());
    if (directMode) {
      if (!await ask("Substituir catálogo?", "O JSON importado substituirá o catálogo no projeto. As capas existentes serão mantidas.", "Importar catálogo")) return;
      await store(next);
      fillForm();
      notice("Catálogo importado e gravado no projeto.");
      return;
    }
    if ((dirty || draft) && !await ask("Substituir catálogo?", "As alterações pendentes na página serão descartadas.", "Importar catálogo")) return;
    await clearSavedCatalog().catch(() => {});
    loadCatalog(next);
    notice("Catálogo importado. Para incluir as capas existentes no ZIP, carregue a pasta imagens.");
  } catch (failure) {
    notice(failure instanceof SyntaxError ? "O arquivo selecionado não é um JSON válido." : failure.message);
  } finally {
    busy = false;
  }
});

$("import-covers").addEventListener("click", () => $("covers-folder").click());
$("covers-folder").addEventListener("change", () => {
  const wanted = new Set(catalog.pacotes.map(({ imagem }) => imagem));
  let imported = 0;
  for (const file of $("covers-folder").files) {
    const path = "imagens/" + file.webkitRelativePath.split("/").slice(1).join("/");
    if (wanted.has(path) && file.size <= MiB && !covers.has(path)) {
      keepCover(path, file);
      imported++;
    }
  }
  $("covers-folder").value = "";
  paintCover();
  renderList();
  notice(imported ? `${imported} capa(s) carregada(s).` : "Nenhuma capa nova corresponde aos caminhos do catálogo.");
});

const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let value = i;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}

async function zip(files) {
  // ZIP with stored entries. Each directory record points to its local header.
  if (files.size > 65535) throw new Error("Há arquivos demais para um único ZIP.");
  const records = [];
  const local = [];
  let offset = 0;
  let directorySize = 0;
  for (const [path, file] of files) {
    const name = encoder.encode(path);
    const data = new Uint8Array(await file.arrayBuffer());
    const checksum = crc32(data);
    const item = new DataView(new ArrayBuffer(30 + name.length));
    item.setUint32(0, 0x04034b50, true);
    item.setUint16(4, 20, true);
    item.setUint16(6, 0x0800, true); // UTF-8
    item.setUint16(12, 33, true); // DOS date 1980-01-01
    item.setUint32(14, checksum, true);
    item.setUint32(18, data.length, true);
    item.setUint32(22, data.length, true);
    item.setUint16(26, name.length, true);
    new Uint8Array(item.buffer, 30).set(name);
    const record = new DataView(new ArrayBuffer(46 + name.length));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true);
    new Uint8Array(record.buffer, 6, 26).set(new Uint8Array(item.buffer, 4, 26));
    record.setUint32(42, offset, true);
    new Uint8Array(record.buffer, 46).set(name);
    local.push(item.buffer, file);
    records.push(record.buffer);
    directorySize += record.byteLength;
    offset += item.byteLength + data.length;
    if (offset + directorySize > 0xffffffff - 22) throw new Error("O ZIP ultrapassa 4 GiB.");
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.size, true);
  end.setUint16(10, files.size, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  return new Blob([...local, ...records, end.buffer], { type: "application/zip" });
}

$("export").addEventListener("click", async () => {
  if (exporting || busy) return;
  if (draft) {
    notice("Salve ou descarte a edição do pacote antes de exportar.");
    $("name").focus();
    return;
  }
  exporting = true;
  $("export").disabled = true;
  try {
    const snapshot = catalogText(catalog);
    const files = new Map([
      ["catalogo.json", new Blob([snapshot])],
      [snapshotName, new Blob([snapshotText(snapshot)])],
    ]);
    const images = new Set(catalog.pacotes.map(({ imagem }) => imagem));
    for (const path of images) {
      if (covers.has(path)) files.set(path, covers.get(path).file);
    }
    const omitted = images.size - files.size + 2;
    const archive = await zip(files);
    const url = URL.createObjectURL(archive);
    const link = Object.assign(document.createElement("a"), { href: url, download: "catalogo-decky.zip" });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    if (snapshot === catalogText(catalog)) dirty = false;
    notice(omitted
      ? `ZIP gerado. ${omitted} capa(s) não carregada(s) devem ser mantidas na pasta imagens do repositório.`
      : "ZIP gerado. Extraia os arquivos na pasta do repositório.");
  } catch (failure) {
    notice(failure.message || "Não foi possível exportar o ZIP.");
  } finally {
    exporting = false;
    $("export").disabled = false;
  }
});

window.addEventListener("beforeunload", (event) => {
  if (!draft) return;
  event.preventDefault();
  event.returnValue = true;
});

refreshStorageMode();
if (globalThis.deckyCatalog) {
  try {
    loadCatalog(parseCatalog(catalogText(globalThis.deckyCatalog)), undefined, undefined, [], true);
  } catch {
    notice("Não foi possível abrir a cópia local. Vincule a pasta do projeto.");
  }
} else {
  fillForm();
}

void (async () => {
  if (location.protocol === "http:" && location.hostname === "127.0.0.1") {
    busy = true;
    try {
      const response = await fetch("/api/catalogo");
      if (!response.ok) throw new Error();
      const text = await response.text();
      const next = parseCatalog(text);
      directMode = true;
      loadCatalog(next, undefined, text, [], true);
      return;
    } catch {
      notice("O editor local não conseguiu abrir o catálogo. Confira se o atalho está rodando.");
    } finally {
      busy = false;
    }
  }
  try {
    const saved = await savedCatalogAccess("readonly", (store, key) => store.get(key));
    if (saved && !busy && !project && !dirty && !draft && !selected) {
      const next = parseCatalog(catalogText(saved.data));
      loadCatalog(next, undefined, undefined, saved.images, saved.localPreviews);
      dirty = true;
      notice("Catálogo recuperado deste navegador. Exporte o ZIP para levar as alterações ao projeto.");
      return;
    }
  } catch {
    // The published snapshot is still available when local storage is unavailable.
  }

  if (!supportsFolder) return;
  try {
    const folder = await projectAccess("readonly", (store, key) => store.get(key));
    if (!folder || await folder.queryPermission({ mode: "readwrite" }) !== "granted") return;
    const text = await readCatalog(await folder.getFileHandle("catalogo.json"));
    const next = parseCatalog(text);
    const images = await projectCovers(folder, next);
    if (!busy && !project && !dirty && !draft && !selected) loadCatalog(next, folder, text, images);
  } catch {
    // The local snapshot remains available if browser permission was revoked.
  }
})();
