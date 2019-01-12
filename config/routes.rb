Rails.application.routes.draw do
  namespace :api do
    namespace :v1 do
      resources :partidos, only: [:index] do
        get 'partie_articles'
        get '/get_ten/:article_id', action: :get_ten
      end
      resources :articles, only: [:index, :show] do
        get 'get_ten'
        get 'article_comments'
      end
      resources :comments, only: [:create, :show] do
      end
    end
  end
end
