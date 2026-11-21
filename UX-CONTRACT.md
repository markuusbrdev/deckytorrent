# Interações do Decky Torrent

| Capacidade | Componente | Comportamento |
| --- | --- | --- |
| Navegação | Decky DialogButton, Focusable e routerHook | Loja e Downloads fecham o painel lateral e abrem uma rota em tela cheia. Voltar usa o histórico da Steam. |
| Select/Listbox | Decky DropdownItem | O filtro de categoria usa o menu do Modo Jogo. |
| Pesquisa | Decky TextField | A busca local por título ignora acentos e combina com o filtro de categoria. |
| Pasta e executável | Decky openFilePicker | Cancelar retorna à tela anterior. O backend valida pasta e executável. |
| Toast | Decky toaster | A conclusão também fica registrada em Downloads. |
| Exclusão | Decky ConfirmModal | Downloads incompletos têm a subpasta removida após confirmação. Downloads concluídos saem da lista e mantêm arquivos e atalhos. |
| Rolagem | Painel da Steam e tela de cada rota | As listas carregam doze itens de cada vez com Mostrar mais. |

O painel inicial mostra downloads com .exe disponível que ainda não viraram atalhos. A Loja apresenta o catálogo local ou a última atualização válida enquanto busca a versão remota. Downloads exibe o progresso atual e retém o último estado conhecido em falhas de consulta. A fila é persistida pelo backend, que também controla o processo aria2.

## Editor local

| Capacidade | Componente | Comportamento |
| --- | --- | --- |
| Select/Listbox | Select nativo no navegador | Cada pacote pertence a uma categoria. |
| Formulários | Campos HTML e validação do editor | Erros aparecem junto ao formulário e o primeiro campo inválido recebe foco. |
| Modais | Dialog nativo no navegador | Escape cancela. A remoção e o descarte de edição pedem confirmação. |
| Feedback | Região de status do editor | Vínculo da pasta, gravação e exportação informam o resultado. |
| Rolagem | Página do editor | Lista e formulário compartilham a rolagem vertical. |

O editor mantém os campos e caminhos compatíveis com o leitor do plugin. Com uma pasta vinculada, as edições são gravadas no projeto ao salvar. Sem vínculo, ficam em memória até a exportação do ZIP. Uma capa já registrada no JSON pode ser mantida no repositório ou carregada para entrar no ZIP.
