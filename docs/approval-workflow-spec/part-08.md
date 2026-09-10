# **9\. TypeScript Builder仕様**

Builderは状態を持つDSL runtimeではなく、型付きAST factory function群とする。返却値は常にJSON serializableなPolicy ASTである。

const policy \= definePolicy({  
  key: "expense",  
  name: "経費申請",  
  rules: \[  
    rule("large", {  
      when: gte(field("action.input.amount"), literal(500\_000)),  
      flow: serial(  
        approve({  
          key: "manager",  
          approver: relation({  
            object: object("org\_unit", field("action.input.orgUnitId")),  
            relation: "manager",  
          }),  
        }),  
        approve({  
          key: "division-manager",  
          approver: relation({  
            object: object("org\_unit", field("action.input.orgUnitId")),  
            relation: "parent\_manager",  
          }),  
        }),  
      ),  
    }),  
  \],  
});

Builderは \`none()\`、\`principal(caller())\`、\`principal(authorityPrincipal())\`、\`managerOf(caller())\`（= principalRelation(caller(), "manager")）、\`managerOf(authorityPrincipal())\` 等のsugarを提供してよい。これらはすべて上記JSON ASTへ展開され、runtime callbackを持たない。Builderが生成した値に \`JSON.stringify\` を適用可能であることをテストで保証する。Builderにクロージャ、class instance、Date、Map等の非JSON値を混入させない。

# **10\. Policy検証・公開・評価**

## **10.1 検証レイヤ**

Policy JSON  
  \-\> structural validation  
  \-\> semantic validation  
  \-\> optional schema/catalog validation  
  \-\> publish

Policy AST自体の構造検証はapproval-core内部の実装詳細とし、利用者が選択するrequest schema libraryとは分離する。ここでも可能であればStandard Schema互換のvalidatorを公開APIに採用できるが、Policy ASTのspecは特定vendorに依存しない。

## **10.2 Semantic Validation**

* Rule key / Step keyの重複禁止  
* serial.childrenは1件以上  
* parallel.childrenは1件以上  
* quorumは1以上かつchildren数以下  
* quorum以外ではquorum指定禁止  
* always Ruleは最後のみ  
* field pathがField Catalogに存在する場合は型・operator整合性を検証  
* relation/objectTypeはRelation Catalogに存在することを推奨  
* schemaVersion未対応は拒否。追加で、\`none\` Flowはchildを持たないこと、candidateCompletionのquorumは1以上かつmaterialize後候補数以下であり、all/quorumではresolution=snapshotであること、onUnresolved=fallbackは循環参照しないこと、PrincipalExpressionが要求するcaller/delegator等のidentityが存在しない場合は既定denyになること、ApprovalPlanCompilerのphase/orderが決定的であること、distinctApprovers=trueのFlowでは同一principalが複数Stepを完了できないことを検証する

## **追加semantic validation: ApprovalPolicyBinding.selector.actionTypesのpattern構文は仕様で定義した完全一致またはprefix wildcardのみに限定し、空selectorは禁止する。Policy-localなstepKey重複は禁止するがPolicy間の同名stepKeyは許可し、MaterializedStepIdで一意化する。expiresAfterは正の値かつCloudflare adapterで表現可能な上限以内、requireCommentOnはapprove/rejectのみ、candidateCompletion=all/quorumはsnapshotかつ完全cohort・maxApproverCandidates以内を要求する。onUnresolved=skipはv1ではschema/semantic errorとする。Conditionのfield root allowlist・型互換・currency付き金額比較もpublish時に可能な範囲で検証する。**

## **10.3 Draft / Publish**

Draft (mutable)  
  \-\> validate  
  \-\> simulate  
  \-\> publish  
Published Policy Version (immutable)

Published Policy Versionにはdefinition、createdBy、createdAt、canonical JSONのchecksumを保存する。Action Definition/Schema versionはActionRequest側へ固定し、Policy Versionとは独立に監査する。

## **10.4 Simulator**

GUI/管理API向けにPolicy Simulatorを提供する。ActionRequest/contextを与え、適用Policy群、各PolicyのmatchedRule/none判定、ApprovalPlanCompilerの合成結果、Materialized Flow、任意でFGAから解決した候補承認者を返す。SimulatorはAuthorization結果を別フィールドとして表示できるが状態変更や実Action実行は行わない。
