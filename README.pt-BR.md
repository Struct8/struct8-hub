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
| Núcleo (`discovery`, `envelope`, `registry`, `report`) | pronto, 28 testes (298 na suíte) |
| Recursos AWS | pronto: 21 módulos, 17 destinos de envio, 12 fontes de evento ([cobertura](docs/coverage.md)) |
| Runtime da AWS Lambda | pronto, invocado de ponta a ponta contra uma conta real |
| Pacote implantável | pronto: `node scripts/bundle.mjs` produz um zip de 44 KiB |
| Runtime de contêiner (ECS) | pronto: entrada HTTP, credencial da task role e consumo de SQS por trás do `HUB_POLL` ([por que uma variável](CONTRACT.md#known-gaps)) |
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

## Rodar no ECS

É o mesmo código, a um parâmetro de build de distância. Função é chamada; processo precisa estar
alcançável, então o contêiner atende HTTP — e lê a task role no endpoint de credencial do ECS,
renovando antes de vencer, porque o ECS não deixa credencial no ambiente como a Lambda deixa.

```
npm run prebuilt:image
docker build -t struct8-hub image
```

O contexto do build é `image/`, e o artefato que ele copia está versionado ali, então um clone
limpo constrói — que é o que um template do CloudMan é, aplicando na conta de outra pessoa.
Detalhes em [image/README.md](image/README.md).

Ligue a caixa do ECS no que ela deve alcançar, ponha um balanceador na frente e mande um `POST`
para a task. **O relatório volta na resposta**, em vez de ir para o CloudWatch — é o jeito mais
rápido de ver se o diagrama está ligado como foi desenhado.

O `GET` é o health check e nunca encaminha: o target group bate nele a cada trinta segundos, então
um health check que disparasse o fan-out acionaria o diagrama inteiro duas vezes por minuto e
cobraria por cada salto. A porta padrão é 8080 e precisa bater com o `containerPort` e com a do
target group.

**Consumir uma fila** custa uma variável, e ela é provisória por um motivo. O gerador só emite os
fios que *saem* de um nó, então uma fila desenhada apontando para este workload não produz nada a
descobrir ([a lacuna](CONTRACT.md#known-gaps)). Desenhe ao contrário — da caixa do ECS para a fila
— e nomeie o rótulo desse fio:

```
HUB_POLL=in
```

A permissão já está certa: a política que um fio de fila gera concede `ReceiveMessage` e
`DeleteMessage` junto com o `SendMessage`. Errada está a seta, e o `HUB_POLL` é o que diz qual dos
dois sentidos possíveis este fio carrega. A origem fica de fora do próprio fan-out, então nenhuma
mensagem é devolvida à fila de onde veio, e só as que foram realmente encaminhadas são apagadas.
Quando o gerador passar a emitir o lado de origem, a variável deixa de ser necessária.

Stream não é consumível, de propósito. Shard, iterador, checkpoint e coordenação de posse entre
tarefas são outro trabalho, e fazê-lo mal produz silêncio ou reprocessamento — não erro.

## Endpoint de teste de carga (educacional, desligado por padrão)

Para os templates de autoscaling do Struct8 há uma segunda rota no runtime de container cujo único
trabalho é gastar CPU sob demanda, para que uma política de escala possa ser observada reagindo a
uma carga que o gerador controla com precisão:

```
HUB_LOADTEST=on
POST /loadtest?ms=200
```

Ela queima cerca de `ms` milissegundos de CPU (com teto de 10 s) e responde quanto tempo de fato
levou. Fica **desligada a menos que `HUB_LOADTEST` esteja setado** — um endpoint que queima CPU sob
demanda é um vetor de negação de serviço se responder por padrão numa conta que nunca pediu por
ele, então, enquanto está desligado, o caminho é um 404, como se não existisse.

Ela está de propósito fora do contrato de fiação: não descobre vizinho, não faz fan-out, não toca
no relatório. Vive num caminho próprio, então o health check `GET` e o fan-out `POST /` se comportam
exatamente igual, ligada ou não. Aponte o k6 para `POST /loadtest?ms=...` através do load balancer,
e o ASG escala pela CPU que cada requisição custa — um custo que você define.

## Rastreamento (X-Ray)

O relatório pode ir para o X-Ray além do log. Cada hop vira um subsegmento — o nome do destino,
quanto tempo levou e o motivo quando falhou — e o rastro segue para a carga seguinte, de modo que
uma requisição que atravessa quatro recursos aparece no console como um rastro, não como quatro.

**Na Lambda não há nada para ligar.** O runtime lê o `_X_AMZN_TRACE_ID`, que a AWS escreve em toda
invocação, e obedece ao que ele diz: `Sampled=1` quando a invocação está sendo rastreada, `Sampled=0`
quando não. Uma função sem rastreamento não envia segmento nenhum e assina exatamente as requisições
que já assinava.

**Em contêiner, use o `HUB_TRACE`.** O ECS não tem ajuste de rastreamento para consultar, e gravar
por padrão passaria a cobrar X-Ray em toda task que baixasse uma imagem nova.

```
HUB_TRACE=on
```

**Permissão:** a execution role na Lambda, a task role no ECS, precisa de `xray:PutTraceSegments` e
`xray:PutTelemetryRecords`. Sem elas o fan-out acontece do mesmo jeito e o log traz
`trace not sent: AccessDenied` — telemetria falhar não é o trabalho falhar.

**Importante:** regra de amostragem do X-Ray não vale aqui. Os segmentos sobem por
`PutTraceSegments`, que grava o que recebe; a regra governa a decisão que um SDK cliente toma, e
aqui não existe SDK cliente — o transporte é `fetch` assinado. Quem decide é o `Sampled` na Lambda e
o `HUB_TRACE` no contêiner.

Duas coisas levam o rastro adiante, e as duas são necessárias:

| hop | o que leva |
|---|---|
| serviço que guarda rastro próprio — SNS, API Gateway, Step Functions, invoke de Lambda | o cabeçalho `X-Amzn-Trace-Id` na requisição assinada |
| fila, para o que vier consumir depois | o atributo de sistema `AWSTraceHeader` do SQS |

O segundo é o que nenhum cabeçalho resolve: quem envia e quem consome nunca conversam, então o
rastro tem que viajar dentro da mensagem. O event source mapping lê esse atributo e abre a invocação
do consumidor no mesmo rastro, e é isso que junta duas funções em uma.

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
