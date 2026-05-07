<cfset variables.userId = url.id>

<cftransaction action="begin" isolation="read_committed">
    <cftry>
        <cfquery name="updateUser" datasource="appdb">
            UPDATE users
            SET last_seen = <cfqueryparam value="#now()#" cfsqltype="cf_sql_timestamp">
            WHERE id = <cfqueryparam value="#variables.userId#" cfsqltype="cf_sql_integer">
        </cfquery>

        <cfquery name="auditEvent" datasource="appdb">
            INSERT INTO audit_log (user_id) VALUES (<cfqueryparam value="#variables.userId#" cfsqltype="cf_sql_integer">)
        </cfquery>

        <cftransaction action="commit" />

        <cfcatch type="any">
            <cftransaction action="rollback" />
            <cfrethrow>
        </cfcatch>
    </cftry>
</cftransaction>

<cftransaction>
    <cfquery name="logTouch" datasource="appdb">
        UPDATE users SET touched = 1 WHERE id = <cfqueryparam value="#variables.userId#" cfsqltype="cf_sql_integer">
    </cfquery>
</cftransaction>
