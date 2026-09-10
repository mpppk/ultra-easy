# **14. 永続化モデル — Part 2**

## **14.4 Cloudflare D1実装規約**

D1はSQLite互換ストレージとして扱い、Drizzle ORMのD1 adapterを使用する。JSON値はTEXTとして保存し、日時はUTCのINTEGER epoch millisecondsまたはISO 8601 TEXTに統一する。WorkflowからD1へ書くside effectはstep.do()のretryを前提にidempotentとし、workflow\_instance\_id \+ event\_key、またはclient\_command\_id等にUNIQUE制約を設ける。domain event、read projection、outboxを同時に更新する場合はD1Database.batch()で原子的に保存する。外部FGA APIやQueue送信をD1の原子更新単位には含めない。

# **15\. 主要ユースケースと整合性制御**

## **15.1 ActionRequest受付 / 実行開始**

1. ActionDefinitionResolverでaction.typeに対応するAction Definition / SchemaReferenceを解決し固定  
2. StandardSchemaV1でaction.inputをvalidate  
3. ActionAuthorizerでauthority/delegation/resource authorizationを評価し、denyなら承認Flowを開始せず拒否する。allowならPolicyBindingResolverで適用Policy群を決定し、各Published Policy Versionを固定  
4. 各Policy evaluatorでActionRequest/contextに対するmatched Ruleまたはnoneを決定し、ApprovalPlanCompilerで合成。合成結果がnoneならRe-Authorization後にActionExecutorへ渡す  
5. 承認が必要な場合のみFlowをMaterializeし、caller/delegator/relation等のApproverExpressionを解決  
6. snapshot stepはApproverResolver.listで完全なuserIds cohortを解決し固定する。dynamic stepもinbox検索用にListUsers結果をapproval\_task\_candidatesへprojectionするが、候補表示は結果整合でありDecision可否の正本にはしない  
7. action\_requestへpolicy\_bindings、Materialized Flow、checksumを固定保存し、承認Flowが存在する場合のみGeneric ActionWorkflow instanceを作成

## **15.2 Approve**

8. APIでrequest/tenant/actorを解決し、対象Workflow instanceへdecision eventを送る準備を行う  
9. API境界でdynamicならApproverResolver.check、snapshotなら固定候補を検証し、明らかな不正操作はsignal前に拒否する  
10. 自己承認禁止等のbusiness constraintもsignal前に事前評価する。ただし最終受理判定はWorkflow Interpreter側で再検証する  
11. API境界でFGA Check等の事前検証を行い、client\_command\_id付きdecision eventをWorkflow instanceへsignalする  
12. Workflow側Interpreterが現在のapproval nodeとeventを照合する。Decision受理時刻をdurable stepで一度だけ確定し、その値をFGA Conditionのcurrent\_time等のrequest-time contextとして再利用してFGA Check・自己承認禁止等を再検証する。FGA障害等のAuthorization errorはdenyと混同せずretriable errorとして扱い、retry枯渇時はdecisionを適用せずauthorization\_check\_failedとして監査する  
13. 受理されたdecisionをstep.do()内でapproval\_decisions / action\_eventsへidempotentにappendする  
14. InterpreterがFlow ASTの次のnodeへ進み、必要なら次のapproval taskをprojectionする  
15. 通知等の外部side effectはOutboxまたはCloudflare Queuesへ委譲し、Workflow stepはidempotentに完了させる  
16. APIはsignal受理を返し、最終的なdecision受理結果はD1 projectionまたはWorkflow状態から参照可能にする

**Race condition対策  API事前CheckとWorkflow処理時点の間に組織関係が変わり得るため、dynamic approverではWorkflow側でも受理直前にFGA Checkを行う。厳密に申請時点の承認者を固定する必要があるPolicyはsnapshotを使用する。**

## **15.3 Reject / Cancel**

reject/cancelもdecision eventとして対象Workflow instanceへ送る。Interpreterは現在待機中のapproval nodeとの整合性を検証し、rejectではFlowをrejectedとして終了する。cancelはActionRequestの人間caller/authority principalまたは明示的にcancel権限を持つprincipalに限定する。send-backはv1.1でInterpreterのloop semanticsとして実装する。
