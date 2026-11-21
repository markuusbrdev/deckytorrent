# Interações do Catálogo Decky

| Capacidade | Componente | Comportamento |
| --- | --- | --- |
| Abas e ações | Decky ButtonItem e Focusable | A aba ativa aparece selecionada e os comandos usam o foco do Modo Jogo. |
| Select/Listbox | Decky DropdownItem | O filtro de categoria usa o menu do Game Mode. |
| Pasta e executável | Decky openFilePicker | Cancelar retorna ao painel. O backend valida pasta e executável. |
| Toast | Decky toaster | A conclusão também fica registrada em Meus downloads. |
| Rolagem | Painel de acesso rápido da Steam | As listas carregam doze itens de cada vez com Mostrar mais. |

A Loja apresenta o catálogo local ou a última atualização válida enquanto busca a versão remota ao abrir. A fila é persistida pelo backend, que também controla o processo aria2. A Steam recebe o atalho após seleção explícita de um executável do pacote.

## Editor local

| Capacidade | Componente | Comportamento |
| --- | --- | --- |
| Select/Listbox | Select nativo no navegador | Cada pacote pertence a uma categoria. |
| Formulários | Campos HTML e validação do editor | Erros aparecem junto ao formulário e o primeiro campo inválido recebe foco. |
| Modais | Dialog nativo no navegador | Escape cancela. A remoção e o descarte de edição pedem confirmação. |
| Feedback | Região de status do editor | Vínculo da pasta, gravação e exportação informam o resultado. |
| Rolagem | Página do editor | Lista e formulário compartilham a rolagem vertical. |

O editor mantém os campos e caminhos compatíveis com o leitor do plugin. Com uma pasta vinculada, as edições são gravadas no projeto ao salvar. Sem vínculo, ficam em memória até a exportação do ZIP. Uma capa já registrada no JSON pode ser mantida no repositório ou carregada para entrar no ZIP.
