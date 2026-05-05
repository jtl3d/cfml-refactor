<cfquery name="getThings" datasource="appdb">
    SELECT * FROM things WHERE 1 = 1
    <cfif a>
        <cfif b>
            AND foo = <cfqueryparam value="#x#" cfsqltype="cf_sql_integer">
        </cfif>
    </cfif>
</cfquery>
