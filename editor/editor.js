"use strict";

const $ = (id) => document.getElementById(id);
const MiB = 1024 ** 2;
const idPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const coverPattern = /^imagens\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(png|jpe?g|webp)$/;
const encoder = new TextEncoder();
const catalogText = (data) => JSON.stringify(data, null, 2) + "\n";
const covers = new Map();
const form = $("package-form");
let catalog = { categorias: [], pacotes: [] };
let selected = "";
let dirty = false;
let draft = false;
let previewUrl;
let exporting = false;
let busy = false;
let project;
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
  $("storage-mode").textContent = project
    ? `Gravação direta na pasta ${project.name}`
    : supportsFolder
      ? "Vincule a pasta do projeto para gravar ao salvar."
      : "Use Chrome ou Edge para gravar direto na pasta. Neste navegador, exporte o ZIP.";
  $("link-folder").hidden = !supportsFolder;
  $("link-folder").textContent = project ? "Trocar pasta do projeto" : "Vincular pasta do projeto";
}

async function fileHandle(folder, path, create = false) {
  const parts = path.split("/");
  const filename = parts.pop();
  for (const part of parts) folder = await folder.getDirectoryHandle(part, { create });
  return folder.getFileHandle(filename, { create });
}

async function availableCoverPath(id, extension, used) {
  for (let suffix = 1; ; suffix++) {
    const path = `imagens/${id}${suffix === 1 ? "" : "-" + suffix}.${extension}`;
    if (used.has(path)) continue;
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

async function store(next, imagePath, image) {
  const text = catalogText(next);
  if (encoder.encode(text).length > MiB) throw new Error("O catálogo atingiu o limite de 1 MiB.");
  if (project) {
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
  }
  if (image) keepCover(imagePath, image);
  catalog = next;
  dirty = !project;
}

function loadCatalog(next, nextProject, text, images = []) {
  for (const cover of covers.values()) URL.revokeObjectURL(cover.url);
  covers.clear();
  for (const [path, file] of images) keepCover(path, file);
  catalog = next;
  project = nextProject;
  diskText = text;
  dirty = false;
  refreshStorageMode();
  fillForm();
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
    const images = [];
    for (const path of new Set(next.pacotes.map(({ imagem }) => imagem))) {
      try {
        const file = await (await fileHandle(folder, path)).getFile();
        if (file.size <= MiB) images.push([path, file]);
      } catch {
        // Missing covers remain referenced and can be replaced in the editor.
      }
    }
    loadCatalog(next, folder, text, images);
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

function paintCover() {
  const saved = catalog.pacotes.find(({ id }) => id === selected);
  const chosen = $("cover").files[0];
  const image = chosen?.size <= MiB ? chosen : covers.get(saved?.imagem)?.file;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = image ? URL.createObjectURL(image) : undefined;
  const preview = $("preview-image");
  preview.hidden = !image;
  $("preview-text").hidden = Boolean(image);
  $("preview-text").textContent = saved ? "Capa no catálogo" : "Sem capa";
  if (previewUrl) preview.src = previewUrl;
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
    const cover = covers.get(entry.imagem);
    if (cover) {
      const image = document.createElement("img");
      image.src = cover.url;
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
$("cover").addEventListener("change", paintCover);
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
  const file = $("cover").files[0];
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
      const used = new Set(catalog.pacotes.filter((entry) => entry !== prior || project).map((entry) => entry.imagem));
      imagem = await availableCoverPath(id, extension, used);
    }
    const entry = { ...prior, id, nome, magnet, categoria, imagem };
    const pacotes = prior ? catalog.pacotes.map((item) => item === prior ? entry : item) : [...catalog.pacotes, entry];
    await store({ ...catalog, pacotes }, imagem, file);
    form.inert = false;
    fillForm(entry);
    notice(project ? `${entry.nome} gravado no projeto.` : `${entry.nome} salvo na página. Exporte o ZIP para gravar no projeto.`);
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
    notice(project ? "Pacote removido do catálogo no projeto." : "Pacote removido do catálogo na página.");
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
    notice(project ? `Categoria ${category.nome} gravada no projeto.` : `Categoria ${category.nome} criada.`);
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
    if ((dirty || draft) && !await ask("Substituir catálogo?", "As alterações pendentes na página serão descartadas.", "Importar catálogo")) return;
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
    const files = new Map([["catalogo.json", new Blob([snapshot])]]);
    const images = new Set(catalog.pacotes.map(({ imagem }) => imagem));
    for (const path of images) {
      if (covers.has(path)) files.set(path, covers.get(path).file);
    }
    const omitted = images.size - files.size + 1;
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
  if (!dirty && !draft) return;
  event.preventDefault();
  event.returnValue = true;
});

refreshStorageMode();
fillForm();
