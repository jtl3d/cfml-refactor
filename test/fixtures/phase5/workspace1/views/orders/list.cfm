<cfquery name="prc.orders" datasource="appdb">
    SELECT id, total
    FROM orders
    WHERE customer_id = <cfqueryparam value="#url.customerId#" cfsqltype="cf_sql_integer">
</cfquery>
