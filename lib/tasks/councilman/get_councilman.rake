namespace :councilman do
    task get_councilman: :environment do
        file = File.join(Rails.root, 'public', '', 'OrgaoComposicaoXIII.json')
        response = JSON.parse(File.read(file))
        mesa = []

        councilmen = response["OrganizacaoAR"]["Plenario"]["Composicao"]["pt_ar_wsgode_objectos_DadosDeputadoSearch"]

        councilmen.each do |dep|   
            if dep["depSituacao"]["pt_ar_wsgode_objectos_DadosSituacaoDeputado"][0].present?
                if !dep["depSituacao"]["pt_ar_wsgode_objectos_DadosSituacaoDeputado"][0]["sioDtFim"].present? && (dep["depSituacao"]["pt_ar_wsgode_objectos_DadosSituacaoDeputado"][0]["sioDes"] == "Efetivo" || dep["depSituacao"]["pt_ar_wsgode_objectos_DadosSituacaoDeputado"][0]["sioDes"] == "Efetivo Temporário" || dep["depSituacao"]["pt_ar_wsgode_objectos_DadosSituacaoDeputado"][0]["sioDes"] == "Efetivo Definitivo")
                    
                    party = Partido.find_by(party_name: dep["depGP"]["pt_ar_wsgode_objectos_DadosSituacaoGP"]["gpSigla"])
                    
                    councilman = {
                        parlament_id: dep["depId"],
                        registration_id: dep["depCadId"],
                        parlament_name: dep["depNomeParlamentar"],
                        parlament_complete_name: dep["depNomeCompleto"],
                        electoral_circle_id: dep["depCPId"],
                        electoral_circle_description: dep["depCPDes"],
                        legislature: dep["legDes"],
                        current_position: dep["depSituacao"]["pt_ar_wsgode_objectos_DadosSituacaoDeputado"][0]["sioDes"],
                        partido_id: party.id
                    }

                    Councilman.create(councilman)
                    
                    if dep["depCargo"].present?
                        mesa_councilman = {
                            assembly_of_republic_table_id: dep["depCargo"]["pt_ar_wsgode_objectos_DadosCargoDeputado"]["carId"],
                            assembly_of_republic_table_role: dep["depCargo"]["pt_ar_wsgode_objectos_DadosCargoDeputado"]["carDes"],
                            assembly_of_republic_table_start_date: dep["depCargo"]["pt_ar_wsgode_objectos_DadosCargoDeputado"]["carDtInicio"],
                            assembly_of_republic_table_end_date: dep["depCargo"]["pt_ar_wsgode_objectos_DadosCargoDeputado"]["carDtFim"]
                        }
    
                        mesa.push(mesa_councilman)
                    end
                end

            elsif !dep["depSituacao"]["pt_ar_wsgode_objectos_DadosSituacaoDeputado"]["sioDtFim"].present? && (dep["depSituacao"]["pt_ar_wsgode_objectos_DadosSituacaoDeputado"]["sioDes"] == "Efetivo" || dep["depSituacao"]["pt_ar_wsgode_objectos_DadosSituacaoDeputado"]["sioDes"] == "Efetivo Temporário" || dep["depSituacao"]["pt_ar_wsgode_objectos_DadosSituacaoDeputado"]["sioDes"] == "Efetivo Definitivo")
                party = Partido.find_by(party_name: dep["depGP"]["pt_ar_wsgode_objectos_DadosSituacaoGP"]["gpSigla"])


                councilman = {
                    parlament_id: dep["depId"],
                    registration_id: dep["depCadId"],
                    parlament_name: dep["depNomeParlamentar"],
                    parlament_complete_name: dep["depNomeCompleto"],
                    electoral_circle_id: dep["depCPId"],
                    electoral_circle_description: dep["depCPDes"],
                    legislature: dep["legDes"],
                    current_position: dep["depSituacao"]["pt_ar_wsgode_objectos_DadosSituacaoDeputado"]["sioDes"],
                    partido_id: party.id
                }

                Councilman.create(councilman)

                if dep["depCargo"].present?
                    mesa_councilman = {
                        assembly_of_republic_table_id: dep["depCargo"]["pt_ar_wsgode_objectos_DadosCargoDeputado"]["carId"],
                        assembly_of_republic_table_role: dep["depCargo"]["pt_ar_wsgode_objectos_DadosCargoDeputado"]["carDes"],
                        assembly_of_republic_table_start_date: dep["depCargo"]["pt_ar_wsgode_objectos_DadosCargoDeputado"]["carDtInicio"],
                        assembly_of_republic_table_end_date: dep["depCargo"]["pt_ar_wsgode_objectos_DadosCargoDeputado"]["carDtFim"]
                    }

                    mesa.push(mesa_councilman)
                end
            end
        end
    end
end
  