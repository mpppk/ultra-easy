# **16\. 外部インターフェース境界（詳細APIは別OpenAPI仕様）**

| Method | Path | 用途 |
| :---- | :---- | :---- |
| POST | /action-requests | ActionRequest受付・認可・Policy評価・即時実行またはWorkflow開始 |
| GET | /action-requests/:id | ActionRequest状態/結果取得 |
| POST | /action-requests/:id/cancel | pending ActionRequest取消 |
| GET | /action-requests/:id/tasks | 承認task/read projection取得 |
| GET | /approval-tasks/:taskId | task詳細 \+ canApprove/候補表示 |
| POST | /approval-tasks/:taskId/decisions | 承認/却下（body.decision=approve|reject） |
| GET | /approval-commands/:commandId | 非同期command処理結果取得 |
| GET | /me/approval-tasks | 承認Inbox取得 |
| POST | /action-requests/simulate | Authorization/Policy/Planシミュレーション |
| POST | /action-definitions | Action Definition作成/新Version |
| POST | /approval-policies | Policy作成/新Version |
| POST | /approval-policy-bindings | Binding作成/更新 |
| POST | /delegations | 代理承認登録 |
| DELETE | /delegations/:id | 代理承認終了 |

外部Adapterは認証・入力validation・ActionRequestへの正規化・trusted resource contextの補完・ActionAuthorizer呼び出し・Workflow create/signal・read model/protocol projection取得を担当する。HTTP、UI、MCPのいずれでもFlowの状態遷移・承認待機・parallel/quorum semanticsをAdapterへ実装してはならない。

汎用の変更系統合APIは\`POST /action-requests\`を正規入口とする。利用アプリケーションは承認要否を事前判定して別APIを選択せず、実行したいaction type/resource/inputを送信する。actorは認証contextから確定し、authority/delegationは認証済みprincipalとserver-side grantから解決する。resourceの現在state、project、orgUnit、classification等、認可・Policy評価に必要なtrusted属性はApplication Adapter/Resource Context Providerが補完し、任意request bodyだけを信用しない。

ActionRequest受付後は、Action Definition validation → Authorization → PolicyBinding/Policy評価の順で処理する。Authorizationがdenyなら実行しない。合成Flowが\`none\`ならWorkflowを作らずRe-Authorization後にActionExecutorを直ちに実行する。Approval Flowが存在する場合のみGeneric ActionWorkflowを開始し、ActionRequestを\`pending\_approval\`として返す。Flow完了後はRe-Authorizationを行ってから同じActionExecutor経路で実行する。代表的な状態は\`pending\_approval\`、\`executing\`、\`executed\`、\`rejected\`、\`cancelled\`、\`expired\`、\`authorization\_revoked\`、\`authorization\_check\_failed\`、\`execution\_failed\`とし、受付直後の短時間な内部状態を外部APIへどこまで公開するかはOpenAPIで確定する。

汎用ActionRequest APIにはdraft→submitの二段階を要求しない。チケット作成フォームや稟議画面で下書きが必要な場合は、利用アプリケーション側のTicket/Draft resourceまたは業務Facadeが保持し、実行要求として確定した時点で\`POST /action-requests\`を呼ぶ。これにより承認不要Actionにも不自然なsubmit操作を要求しない。

利用アプリケーションが\`checkPermission()\`成功後に別トランザクションでresourceを直接変更する方式を標準経路にしない。認可・承認・Re-Authorization・実処理をActionRequest→ActionExecutorの一連の経路に含め、承認待ち中の権限変更やTOCTOUを検出可能にする。read-onlyな事前表示用途のpermission check/simulationは別途提供してよいが、mutationの安全性根拠にはしない。

Decision mutationは承認結果の同期確定ではなくcommand受理として扱い、必要に応じてcommandIdを返す。projectionは結果整合であるため、クライアントは\`GET /approval-commands/:commandId\`またはActionRequest/Task read modelでapplied/rejected/failedを確認する。Action Definition、Approval Policy、Policy BindingのCRUD/publish/versioning endpointは管理APIとして提供するが、本章の表は代表境界のみを示す。request/response、HTTP status、Idempotency-Key、Problem Details、pagination等の正規Contractは別管理のOpenAPI 3.1仕様をSource of Truthとする。
