# Hub

[English](README.md) · **Português**

O Hub é o código que roda *dentro* dos recursos que você desenha.

Você desenha um diagrama — uma função, uma fila, um bucket, um fio ligando os três. O Struct8
gera a infraestrutura. O Hub é o que preenche a computação: ele descobre todo recurso ao qual foi
ligado, repassa para todos eles o que chegar, e relata cada salto para você ver o diagrama
funcionando.

**Não existe lista de destinos no código.** Quem configura o Hub é o fio.

```js
import { hub } from '@struct8/hub';
import '@struct8/hub/r/aws_sqs_queue';
import '@struct8/hub/r/aws_s3_bucket';

export const handler = hub.lambda();
```

O arquivo gerado é isso. Todo o resto está versionado dentro do pacote.

---

## Situação

**Pré-lançamento: não está no npm, e ainda não tem versão.** O lado AWS está completo e já rodou
contra uma conta real. Nada aqui foi aplicado a partir de um diagrama.

| peça | estado |
|---|---|
| [Contrato de fiação](CONTRACT.md) v1 | documentado, corresponde ao que o gerador emite hoje |
| Núcleo (`discovery`, `envelope`, `registry`, `report`) | pronto, 161 testes |
| Recursos AWS | pronto: 18 módulos, 14 destinos de envio, 12 fontes de evento ([cobertura](docs/coverage.md)) |
| Runtime da AWS Lambda | pronto, invocado de ponta a ponta contra uma conta real |
| Pacote implantável | pronto: `node scripts/bundle.mjs` produz um zip de 44 KiB |
| Runtime de contêiner / VM | depende da descoberta pelo lado de origem — ver [CONTRACT.md](CONTRACT.md#known-gaps) |
| Runtime do Cloudflare Workers | planejado |

**Já existe um arquivo pronto no repositório: [`prebuilt/index.mjs`](prebuilt/index.mjs)** — um
arquivo, todos os recursos AWS, sem dependência, `nodejs22.x` / `index.handler`. Pegue como está,
ou construa um menor.

**Você não precisa de npm para rodar isto.** O `scripts/bundle.mjs` embute o núcleo, os recursos
que o seu diagrama usa e o assinador de requisição num arquivo só, então a função não carrega
dependência nenhuma:

```
node scripts/bundle.mjs --resources aws_sqs_queue,aws_s3_bucket
# build/hub.zip -- handler index.handler, runtime nodejs22.x
```

O que ainda *não* aconteceu: uma implantação conduzida por um diagrama do CloudMan. As variáveis
de ambiente foram entregues ao handler à mão, iguais às que o gerador emite, e ele chegou na AWS
corretamente. Provar a saída real do gerador contra este leitor é o próximo passo.

Fio entre provedores (uma Lambda escrevendo no R2, um Worker lendo do SQS) está **fora do escopo
por enquanto**, e de propósito o desenho não gira em torno disso. A
[arquitetura](docs/architecture.md) explica quais costuras ficaram abertas para que isso possa
chegar depois sem reescrita.

## Usar num template do CloudMan

O Terraform zipa uma *pasta* no apply, então o código é um arquivo dentro de uma pasta — sem npm
install, sem upload para o S3, sem etapa de build.

1. Pegue o [`prebuilt/index.mjs`](prebuilt/index.mjs).
2. Ponha em `CloudMan-Templates/LambdaFiles/<nome lógico do nó Lambda>/index.mjs`.
3. Configure a função como `nodejs22.x`, handler `index.handler`.

**O nome da pasta tem que ser igual ao nome lógico do nó.** É ele que compõe o `source_dir` do
`archive_file` gerado; nome diferente produz um arquivo vazio e uma função que não sobe.

Depois ligue a função no que ela deve alcançar. Nada além disso: não há lista de destinos para
manter, nem código para escrever. O Hub lê os fios do próprio ambiente e relata o que cada um fez —
qual alvo, quanto tempo, e o motivo quando algum falha.

Detalhes, e como construir um arquivo menor, em [prebuilt/README.md](prebuilt/README.md).

## Como funciona

**Descoberta.** O gerador injeta uma variável de ambiente por fio, nomeada com o tipo do alvo, o
valor que ela carrega e o rótulo do próprio fio. O Hub lê esses nomes e remonta a lista de
vizinhos. Nada é fixo no código, e um fio que o diagrama não tem não pode ser alcançado.

**Normalização.** O que quer que tenha disparado a carga — um lote de fila, um objeto criado, uma
requisição HTTP, um registro de stream — é reduzido a uma lista de itens mais uma descrição de
onde eles vieram. Uma forma só para toda origem.

**Espalhamento.** Cada vizinho é procurado no registro e recebe a mensagem. Uma função pequena por
tipo de recurso; o núcleo nunca aprende o nome deles.

**Relatório.** Cada salto produz uma linha: qual fio, qual alvo, quanto tempo, e o que falhou.
Esse relatório é o objetivo — é ele que diz que o diagrama está ligado do jeito que você desenhou.

## Documentação

| | |
|---|---|
| [Guia inicial](docs/getting-started.pt-BR.md) | primeira execução, cinco minutos |
| [prebuilt/index.mjs](prebuilt/index.mjs) | o arquivo pronto, e onde ele entra num template |
| [CONTRACT.md](CONTRACT.md) | o contrato de fiação — leia para escrever o seu próprio Hub *(inglês)* |
| [Arquitetura](docs/architecture.md) | as quatro portas, e por que o corte é onde é *(inglês)* |
| [Cobertura](docs/coverage.md) | o que o Hub alcança, o que não alcança, e por quê *(inglês)* |
| [Acrescentar um recurso](docs/adding-a-resource.md) | uma pasta, um arquivo, nenhuma mudança no núcleo *(inglês)* |

O contrato é versionado e independente desta implementação. Se você preferir escrever o seu
próprio hub, na sua própria linguagem, o [CONTRACT.md](CONTRACT.md) basta — isso é intencional.

## Licença

[Apache 2.0](LICENSE).
