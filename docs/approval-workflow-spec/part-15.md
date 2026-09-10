# **15. 主要ユースケースと整合性制御 — Part 2**

## **15.4 Idempotency**

HTTP/MCP等のmutationにはIdempotency-Key / client\_command\_id等の安定したcommand identityを付与する。Workflowへ送るdecision eventにもclient\_command\_idを含め、approval\_decisions / action\_events側に一意制約を設ける。step.do()のretryやtransport再送が発生しても同一decisionを二重記録しない。承認bindingは3つの独立checksumへ分離する。\`actionFingerprint\`は正規化済みaction type/resource/input/Action Definition Version（添付がある場合はcontent hashを含む）だけを対象とし、Policyやorganization settingsを混ぜない。\`evaluationSnapshotChecksum\`はactor/authority/delegation/origin/organization settings/derived attributes/evaluation time等、Policy評価に使った非Action contextの固定snapshotを対象とする。\`approvalPlanChecksum\`は適用PolicyBinding/Policy Version、Materialized Flow、MaterializedStepId、interpreterSemanticsVersion等を対象とする。ApprovalDecisionはこれら3値を組み合わせた\`approvalBindingFingerprint\`へbindする。canonical JSONはRFC 8785（JCS）、hashはSHA-256、文字列表現は\`sha256:\<lowercase-hex\>\`とする。JCSとは別のUnicode normalizationは行わない。入力正規化が必要な場合はAction Definition validation段階で行う。3値のいずれかが変化した場合は既存承認を再利用せず、必要に応じて新ActionRequestとしてAuthorization・PolicyBinding解決・Policy評価をやり直す。

## **15.5 Parallel any / quorumのevent collector** **parallel any / quorumでは、複数のwaitForEventをPromise.race()/Promise.any()で競合させることを標準実装としない。1つのdecision event typeを繰り返しwaitし、actor重複・authorization・decision内容を検証してcollectorへ蓄積し、anyまたはquorum条件成立時に次へ進む。event名とstep名はFlow node keyとiterationからdeterministicに生成する。** **15.6 ユースケース別Flow表現**

以下をv1の受入テストケースとして固定する。すべてActionAuthorizerでALLOWされた後にApproval Policyを評価し、Flow完了後は必ずRe-Authorizationを行ってからActionExecutorで実行する。

Case 1: 権限を持つ人間・承認不要

actor=user、authority.principal=同一user。Flowは { type: "none" }。Authorization通過後、そのままActionExecutorへ進む。

Case 2: 権限を持つ人間・上長承認

actor=user、authority.principal=同一user。Flowは approval(principal\_relation(authority\_principal, "manager"))。selfApprovalはdeny、subjectはauthority\_principalを既定とする。

Case 3: 権限を持つAI・承認不要

actor=agent。authority.principalはagent自身または委譲元principal。Effective AuthorityがALLOWならFlowは { type: "none" }。AIであること自体は承認必須条件にしない。

Case 4: 権限を持つAI・AI呼び出し者の承認

actor=agent、origin.caller=user。Flowは approval(principal(caller))。purpose=execution\_consent、selfApproval=allow。caller identityはActionRequest受付時にbindする。

Case 5: 権限を持つAI・caller承認→caller上長承認

Flowは serial(approval(principal(caller)), approval(principal\_relation(caller, "manager")))。前者purpose=execution\_consent、後者purpose=business\_approval。callerとmanagerが同一人物になる異常構成ではSoD制約またはself-approval制約によりfail closedとする。

Case 6: 権限を持つAI・caller承認不要・caller上長承認

Flowは approval(principal\_relation(caller, "manager"))。caller本人のexecution consentを要求しないPolicyでも、caller identityは上長解決の基点として必要である。caller不在時はonUnresolvedの既定denyとする。
